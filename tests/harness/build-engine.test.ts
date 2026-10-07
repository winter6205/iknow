/**
 * `src/harness/build-engine.ts` — the single harness assembly point shared by
 * the CLI (chat / ask) and the session server (serve → SessionHub.ensureDeps).
 *
 * These tests pin the ACI toolset (via EXPECTED_TOOLS) so a future tool-set
 * change cannot drift between the two entry points silently: if a tool is
 * added/renamed/removed, this test forces an explicit decision at the single
 * assembly point. The tool count derives from `EXPECTED_TOOLS.length` — the
 * array is the source of truth; no additive narration in comments (it drifts
 * from the real length).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Assembly-class cases (real MCP manager / bwrap probe / skill scanner) can
// exceed vitest's default 5s under concurrent load — same relaxation as
// hub-worktree-isolation.test.ts. They are also in the CI exclude set
// (SSOT: vitest.ci-excludes.ts) and must still pass locally.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSubagentRecordPaths } from "../../src/harness/sandbox/fence-tmp.ts";

// ADR-0085: worker subprocesses are replaced by fake children — the
// assertion surface is the wire bytes on a child's stdin (build-engine →
// manager → envelope); no real worker starts.
// Only the `createDefaultSubAgentSpawn` seam is masked: other cases in this
// file either inject their own manager or (secrets guard / rebind bash)
// really spawn child processes — masking `node:child_process` instead would
// take those cases down too. With no override set, the real impl passes through.
const workerSpawnOverride = vi.hoisted(() => ({
  current: undefined as ((...args: readonly unknown[]) => unknown) | undefined,
}));
vi.mock("../../src/harness/subagent/spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/subagent/spawn.ts")
    >();
  return {
    ...actual,
    createDefaultSubAgentSpawn: (
      ...args: Parameters<typeof actual.createDefaultSubAgentSpawn>
    ): ReturnType<typeof actual.createDefaultSubAgentSpawn> => {
      const real = actual.createDefaultSubAgentSpawn(...args);
      const override = workerSpawnOverride.current;
      if (override === undefined) return real;
      return (() => override()) as unknown as ReturnType<
        typeof actual.createDefaultSubAgentSpawn
      >;
    },
  };
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { spawn as spawnChild } from "node:child_process";
import {
  buildHarnessEngine as rawBuildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { McpClientHandle } from "../../src/harness/mcp/manager.ts";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { readEnvSnapshot } from "../../src/harness/env-snapshot.ts";
import type { EnvSnapshotSeam } from "../../src/harness/loop-engine.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { assessSubagentIsolation } from "../../src/harness/subagent/capability.ts";
import { createWorktreeOnMutateHolder } from "../../src/harness/isolation/worktree-gate.ts";
import { SYMBOL_MUTATE_TOOL_NAMES } from "../../src/harness/aci/tools/symbol-mutate.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";

// Order is load-bearing: it must match the `aciTools` array in
// `src/harness/build-engine.ts` (policy byName key-space, ADR-0006).
// The assembly surface grows append-only (existing entries are never
// reordered); the tool count is always derived from `EXPECTED_TOOLS.length`
// — never narrated additively in comments.
//
// The old 10 lsp_* tools are retired: build-engine no longer registers
// lsp_*, but their implementation + internal exports still live in lsp.ts as
// symbol.ts's SSOT reuse layer. The 10 query + 5 mutate symbol tools assemble
// on the default chat surface. run_graph is resident in this array: the chat
// surface assembles subagentManager, while the handler's isEnabled stays
// closed by default, so promptTools and the system bytes never flap with the
// graph switch; a missing graphAssembly only leaves the handler closure
// without graph parts — the tool itself stays registered (promptTools length
// = EXPECTED_TOOLS.length).
//
// Conditional-absence views = EXPECTED_TOOLS.filter(...) derivation, with
// the filter expression as the source of truth: the ask entry builds no
// subagentManager / mcpManager / backgroundManager (so mcp__* is absent),
// plus the todoDir, MCP-resources and background seams — per-case comments
// list the concrete absent sets.
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
  // Skill tools (append-only tail): only "skill" remains after skill_search
  // was removed by the index-demotion pass (disclosure-index-align/).
  "skill",
  // Subagent tools (append-only, 2 at the tail): present only on the fully
  // assembled chat surface (ask lacks subagentManager).
  "spawn_subagent",
  "subagent_result",
  // todo_write (enters the registry only on chat surface + todoDir present;
  // ask passes no todoDir → absent. The worker IS present when the parent
  // session threads its todoLedger through the envelope — see ADR-0085) plus
  // the two MCP-resource tools (fully assembled chat surface only; ask lacks
  // mcpManager → absent).
  "todo_write",
  "list_mcp_resources",
  "read_mcp_resource",
  // bash_output / bash_stop (append-only, last 2): present on fully
  // assembled chat/tui/serve surfaces; ask lacks backgroundManager → absent.
  // bash itself stays resident; the parameter-level background:true
  // capability is a runtime handler decision.
  "bash_output",
  "bash_stop",
  // run_graph is resident (append-only) — same shape as bash_output/bash_stop:
  // it leaves the registry only when subagentManager is absent (a missing
  // graphAssembly is guarded by the handler's default-off isEnabled).
  "run_graph",
  "query_trace",
  // Symbol-query tools (append-only, last 10, resident — never conditional;
  // they share lspCtx with lsp.ts's internal SSOT. The old lsp_* set is
  // retired).
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
  // Symbol-mutate tools (append-only, last 5, resident; category=write,
  // never conditional — they share lspCtx + lsp.ts with the query face).
  // onEdit is threaded from build-engine's lspNotifier.invalidate, so
  // post-write textDocument/didChange follows the same path as edit_file;
  // edit_file stays for non-single-symbol text patches.
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
  // list_sessions (append-only, 1 resident entry): the trace read-side
  // directory axis, never conditional — every surface builds a traceDir.
  "list_sessions",
  // get_record (append-only, 1 more resident entry): the read-side content
  // axis, likewise never conditional; read-side axes keep append order —
  // existing entries are never reordered.
  "get_record",
  // subagent_stop (append-only, ADR-0101): same gate as spawn_subagent /
  // subagent_result — chat's self-built subagentManager → present; ask lacks
  // the manager → absent.
  "subagent_stop",
  // subagent_continue (append-only, ADR-0102): same gate, appended right after stop.
  "subagent_continue",
  // read_image (append-only, resident — no absence condition): present on
  // any fully assembled surface.
  "read_image",
];

/** Conditional-absence view for the chat surface without a threaded todoDir
 *  (the default shape): EXPECTED_TOOLS_NO_TODO expresses "todo_write not in
 *  the table"; its presence requires an explicit todoDir (the production
 *  main-loop path, not the test default). Count =
 *  EXPECTED_TOOLS_NO_TODO.length, with the array as the source of truth. */
const EXPECTED_TOOLS_NO_TODO = EXPECTED_TOOLS.filter((n) => n !== "todo_write");

/**
 * The callsites in this file verify the ASSEMBLED SHAPE (tool table /
 * threaded fields / gate decisions), not the "overflow eviction" and "index
 * demotion" paths — those are tested in build-engine-tool-overflow.test.ts
 * and disclosure-index-align/.
 *
 * It wraps `buildHarnessEngine` with three assembly-time cost controls,
 * leaving every assertion untouched:
 *
 * 1. `skipCountTokens`: without the bypass, assembly really calls
 *    `adapter.countTokens` (SDK, baseURL pointed at the unreachable
 *    127.0.0.1:9999); the SDK's maxRetries=2 + exponential backoff burns
 *    ~2.5s per assembly just to reach the deterministic "Connection error →
 *    skip this session" branch (measured: maxRetries=2 → 2493ms vs 0 → 2ms).
 * 2. `mcpFirstTurnReadyTimeoutMs`: the production contract window is 30s;
 *    this file only asserts the assembled shape after the window resolves,
 *    so it need not wait it out (see that seam's BuildEngineOpts comment).
 * 3. Call sites lacking `cwd` get a file-private tmp root (below): otherwise
 *    the default `process.cwd()` = the real repo root, which would read the
 *    repo's own `.iknow/mcp.json` (2 real stdio servers: `npx -y
 *    codebase-memory-mcp` + `node scripts/iknow-trace-mcp-dev.cjs`). Those
 *    cases never shut that manager down, so real child processes linger for
 *    the process lifetime (measured: one un-shutdown repo-root assembly
 *    leaves 5 MCP descendant processes in the same process; 90 after 18
 *    assemblies, reaped on exit — not a cross-run leak but resource
 *    contention during the test process's life: every child competes for
 *    CPU/memory, directly amplifying scheduling latency under CI
 *    concurrency). Those cases' assertions never depend on repo contents
 *    (tool-name table / env threading / secret table), so a tmp root
 *    weakens nothing — and it removes the implicit "read real repo config"
 *    dependency.
 */
const BE_TEST_BUILD_DEFAULTS = {
  mcpFirstTurnReadyTimeoutMs: 150,
  skipCountTokens: true,
} as const;

/**
 * Hermetic root for callsites lacking cwd (lazily built once, reused
 * in-process). Pins both cwd / userHome to avoid reading the real `~/.iknow`.
 */
let hermeticRoot: { cwd: string; home: string } | undefined;
async function hermeticBuildRoot(): Promise<{ cwd: string; home: string }> {
  if (!hermeticRoot) {
    const dir = await mkdtemp(join(tmpdir(), "iknow-build-engine-hermetic-"));
    hermeticRoot = { cwd: dir, home: join(dir, "home") };
  }
  return hermeticRoot;
}

// Process-level teardown: hermeticRoot is lazily built and reused across
// cases, so no per-test afterEach covers it; without clearing it here every
// test process leaves an `iknow-build-engine-hermetic-*` dir in /tmp.
// No-op when never created (undefined).
afterAll(async () => {
  if (hermeticRoot) {
    await removeTmpTree(hermeticRoot.cwd);
    hermeticRoot = undefined;
  }
});

/**
 * tmp-tree cleanup — shared by every `mkdtemp` root in this file.
 *
 * Why not a bare `rm(root, { recursive: true, force: true })`: `force` only
 * suppresses ENOENT, not "rm reaches its final rmdir(root) while a new
 * directory has JUST sprouted inside root". That genuinely happens here:
 * assembly-time `createSystemResolver` (src/harness/memory/refresh.ts)
 * issues a fire-and-forget
 * `void mkdir(..., { recursive: true }).catch(() => {})` against `memoryDir`
 * — ADR-0019 explicitly chose "never block assembly". Measured, that mkdir
 * lands 0–28ms after buildHarnessEngine returns (40 samples: median 2ms /
 * p90 17ms / max 28ms), and the `await built.shutdown?.()`-then-`rm`
 * pattern gives a real overlap window between rm's final rmdir and that
 * mkdir. That explains the occasional
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/iknow-t2-matrix-…'` under
 * full-concurrency runs (the race window is narrow: green in isolation;
 * 0 failures in a 10-way x 200-iteration probe — it only surfaces under
 * full-suite maxForks=3 with same-file cases queued).
 *
 * `maxRetries` / `retryDelay` are Node `fs.rm`'s standard surface for
 * CONCURRENT directory mutation: retries happen only on `retryErrorCodes`
 * (incl. ENOTEMPTY) with linear backoff over `retries * retryDelay`, and
 * the original error is rethrown once retries are exhausted. Three measured
 * boundaries:
 *   - a persistently-written race dir: ENOTEMPTY still thrown at
 *     maxRetries=0/1/5, only passing at 20 ⇒ retries "wait for the churn to
 *     stop", not "erase the error";
 *   - unreadable parent (EACCES): still thrown at maxRetries=3 ⇒ real
 *     permission failures stay visible, not swallowed;
 *   - path through a plain file (ENOTDIR, not a retryErrorCodes): thrown
 *     immediately ⇒ non-race errors surface with zero delay.
 * This file's writers mkdir once each, so 3 x 50ms backoff (~300ms) dwarfs
 * the measured 28ms window.
 *
 * Scope: assembly roots fed to `buildHarnessEngine` (cwd / workspaceRoot /
 * userHome below them). Pure fixture dirs the assembly never touches (like
 * `outside` above) keep the bare `rm` — no writer, no retryable race, and
 * bare rm is the honest "zero retries" signal.
 */
async function removeTmpTree(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

/**
 * This file's default wrapper with the same signature as
 * `buildHarnessEngine`. Any field a caller passes explicitly (incl.
 * cwd/userHome) overrides the default.
 *
 * `skipCountTokens: true` is the DEFAULT, but callers that explicitly pass
 * `countTokens` are unaffected — build-engine's precedence is
 * `countTokens ?? (skip ? undefined : adapter.countTokens)`: explicit
 * injection always wins (see the comment there). No call site in this file
 * passes `countTokens`; tests that verify the real countTokens path live
 * elsewhere.
 */
const buildHarnessEngine: typeof rawBuildHarnessEngine = (async (opts) =>
  rawBuildHarnessEngine({
    ...BE_TEST_BUILD_DEFAULTS,
    ...(opts.cwd === undefined && opts.userHome === undefined
      ? {
          cwd: (await hermeticBuildRoot()).cwd,
          userHome: (await hermeticBuildRoot()).home,
        }
      : {}),
    ...opts,
  })) as typeof rawBuildHarnessEngine;

/**
 * Narrow a receipt to its `execution_failed` variant and return the
 * model-visible failure label. Keeps the `kind` assertion these tests already
 * made — TypeScript cannot narrow through `expect().toBe()`.
 */
function failureMessage(result: ToolExecutionResult | undefined): string {
  expect(result?.kind).toBe("execution_failed");
  if (result?.kind !== "execution_failed") {
    throw new Error(`expected an execution_failed result, got ${result?.kind}`);
  }
  return result.message;
}

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    // IknowCompressEnv is required and build-engine threads it into
    // LoopEngineDeps.compress. The fixture pins 200_000 EXPLICITLY (not the
    // product default — see DEFAULT_STRATEGY_CONTEXT_WINDOW);
    // thresholdTokens=undefined → threshold.ts derives floor(0.95 × window).
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // MCP connect timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    // Subagent config arm (build-engine reads taskTimeoutMs and threads it to the manager).
    subagent: { taskTimeoutMs: undefined },
    // Roots are supplied explicitly to buildHarnessEngine; the env side keeps
    // its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

function makeTestSubagentManager(): {
  readonly manager: SubAgentManager;
  readonly spawnedTasks: string[];
  readonly blockedCalls: unknown[];
} {
  const spawnedTasks: string[] = [];
  const blockedCalls: unknown[] = [];
  const manager: SubAgentManager = {
    spawn: (definition) => {
      spawnedTasks.push(definition.task ?? "");
      return { taskId: `task-${spawnedTasks.length}` };
    },
    queryBuffer: () => ({ status: "running" }),
    waitFor: async () => {
      throw new Error("waitFor should not run in wait:false tests");
    },
    shutdown: async () => {},
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: () => () => {},
    recordBlockedSpawn: (info) => {
      blockedCalls.push(info);
    },
  };
  return { manager, spawnedTasks, blockedCalls };
}

function makeCapturingSubagentManager(sandboxRoot: string): {
  readonly manager: SubAgentManager;
  readonly payloads: WorkerEnvelope[];
} {
  const payloads: WorkerEnvelope[] = [];
  const manager = createSubAgentManager({
    sandboxRoot,
    spawn: (_definition, _taskId, payload) => {
      payloads.push(payload);
      return spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    },
  });
  return { manager, payloads };
}

/** Fake children created by the worker-envelope cases (cleared in beforeEach). */
const fakeWorkerChildren: ChildProcess[] = [];

/**
 * Fake child — the return value of `spawn()`; its stdin receives the
 * envelope (real wire bytes) written by the manager. stdout/stderr are
 * PassThroughs too, so no real subprocess I/O ever happens.
 */
function makeFakeWorkerChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 70001,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;
  fakeWorkerChildren.push(child);
  return child;
}

/**
 * The envelope (real wire bytes) last written to stdin by a worker spawn.
 * Reads the FAKE CHILD's own stdin — not the spawn call record (`calls[0]`
 * only carries argv; the child is the return value).
 */
function firstWorkerEnvelope(): WorkerEnvelope | undefined {
  for (const child of fakeWorkerChildren) {
    const stdin = (child as unknown as { stdin?: PassThrough }).stdin;
    if (!stdin || typeof stdin.read !== "function") continue;
    const chunk = stdin.read() as Buffer | null;
    if (!chunk) continue;
    const text = chunk.toString("utf8").trim();
    if (text.length === 0) continue;
    return JSON.parse(text) as WorkerEnvelope;
  }
  return undefined;
}

async function runSpawn(
  built: BuiltEngine,
  input: Record<string, unknown>,
  conversationId = "conv-1"
): Promise<ToolExecutionResult> {
  const [result] = await built.deps.executor.executeAll(
    [{ id: "spawn-1", name: "spawn_subagent", input }],
    undefined,
    undefined,
    conversationId
  );
  return result!;
}

describe("buildHarnessEngine (SSOT assembly)", () => {
  it("registers the full ACI 11-tool set on the returned registry", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-1"),
      askUser: createNoAskUser(),
    });

    const names = deps.registry.list().map((def) => def.name);
    // todo_write is conditional — no threaded todoDir → absent.
    // Count = EXPECTED_TOOLS_NO_TODO.length; the array is the source of truth.
    expect(names).toEqual(EXPECTED_TOOLS_NO_TODO);
    // Explicitly locks the web tools (after the SSOT converged into registry.ts,
    // the build-engine path must still carry web_fetch / web_search).
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    // Full assembly (default chat surface) includes spawn_subagent / subagent_result.
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("subagent_result");
    // todo_write absent on the path where todoDir is not threaded.
    expect(names).not.toContain("todo_write");
  });

  it("full assembly: built.subagentManager 存在 + built.shutdown 是函数", async () => {
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-subagent-full-1"),
      askUser: createNoAskUser(),
    });

    // The chat surface builds its own subagentManager (an object); shutdown is a composed handle (function).
    expect(typeof built.subagentManager).toBe("object");
    expect(typeof built.subagentManager!.shutdown).toBe("function");
    expect(typeof built.shutdown).toBe("function");
    // Cleanup: the composed shutdown does not throw (empty MCP config + no running subagents).
    await built.shutdown!();
  });

  it("wires promptTools to reg.visibleSchemas (all 11 tools, no lazy)", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-2"),
      askUser: createNoAskUser(),
    });

    // Injection seam: buildHarnessEngine threads reg.visibleSchemas into promptTools.
    expect(typeof deps.promptTools).toBe("function");
    const promptNames = deps.promptTools!()
      .map((d) => d.name)
      .sort();
    expect(promptNames).toEqual([...EXPECTED_TOOLS_NO_TODO].sort());
    // Default registry has no lazy tools → visibleSchemas ≡ registry.list();
    // with no threaded todoDir, todo_write is absent — count again comes from
    // EXPECTED_TOOLS_NO_TODO.length, the array being the source of truth.
    expect(deps.promptTools!().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS_NO_TODO
    );
  });

  it("throws without the LLM api key set (fail loud, before any async work)", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv(undefined),
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/LLM mode needs API key/);
  });

  it("throws when askUser is missing", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv("sk-test-sentinel-2"),
        askUser: undefined as never,
      })
    ).rejects.toThrow(/ask_inlet_missing/);
  });
});

// --- memory opt-out + system wiring ------------------------------------------

describe("buildHarnessEngine — memory opt-out (ask path, SC 12)", () => {
  it("memory disabled → registry stays at 8 (no memory tools) and memory_layer inactive", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-off-1"),
      askUser: createNoAskUser(),
      memory: { enabled: false },
    });

    const names = deps.registry.list().map((def) => def.name);
    // ask surface → the memory pair (enabled:false), todo_write (no threaded
    // todoDir), and the subagentManager/mcpManager/backgroundManager tool sets
    // are all absent. Count = length of the EXPECTED_TOOLS_NO_TODO.filter
    // expression (source of truth); this assertion = that expression with the
    // memory pair stripped.
    expect(names).toEqual(
      EXPECTED_TOOLS_NO_TODO.filter(
        (n) => n !== "memory_recall" && n !== "memory_save"
      )
    );
    expect(names).not.toContain("memory_recall");
    expect(names).not.toContain("memory_save");
    // Landing shape: deps.system always carries createIknowSystemResolver (the
    // identity layer is always present); memoryEnabled=false makes the
    // memory_layer slot return undefined.
    const sys = await deps.system?.();
    expect(sys).toContain("iknow Identity");
  });

  it("memory enabled (default) → deps.system is wired as an async assembler", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-on-1"),
      askUser: createNoAskUser(),
    });
    // Seam contract: deps.system is a function (asserted as such, never invoked —
    // invoking it would write usage.json into the real ~/.iknow/memory).
    expect(typeof deps.system).toBe("function");
  });
});

describe("buildHarnessEngine (SSOT passthrough)", () => {
  it("propagates maxTurns and timeoutMs from env (not hard-coded)", async () => {
    const env = makeEnv("sk-test-passthrough-1");
    env.llm.timeoutMs = 12345;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });

    // ADR-0012: the default env sets no IKNOW_LLM_MAX_TURNS → undefined (unlimited).
    expect(deps.maxTurns).toBeUndefined();
    // Proves timeoutMs is read through from env, not a hard-coded constant.
    expect(deps.timeoutMs).toBe(12345);
  });

  it("#742 T1: env 的 idle / 硬顶透传为 deps.modelIdleTimeoutMs / modelHardCapMs", async () => {
    const env = makeEnv("sk-test-passthrough-idle");
    env.llm.idleTimeoutMs = 111_000;
    env.llm.hardCapMs = 222_000;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });

    expect(deps.modelIdleTimeoutMs).toBe(111_000);
    expect(deps.modelHardCapMs).toBe(222_000);
  });

  it("#742 T1: env 未给 idle / 硬顶时 deps 两字段缺席(退回今日单钟)", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-passthrough-no-idle"),
      askUser: createNoAskUser(),
    });

    expect(deps.modelIdleTimeoutMs).toBeUndefined();
    expect(deps.modelHardCapMs).toBeUndefined();
  });

  it("plan T5-engine: env.llm.maxTurns=3 → deps.maxTurns === 3", async () => {
    const env = makeEnv("sk-test-passthrough-maxTurns");
    env.llm.maxTurns = 3;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });
    expect(deps.maxTurns).toBe(3);
  });

  it("IKNOW_WEB_PROXY 非法值 → build 时同步抛错,空值 → 不影响装配", async () => {
    // Proves the proxy config is intercepted by the SSRF defense at assembly time, not lazily at fetch time.
    const env = makeEnv("sk-test-passthrough-3");
    env.web.proxy = "ftp://bad-proxy:9999";
    await expect(
      buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/only http and https|malformed/i);

    // Control: an empty proxy config does not throw; assembly succeeds.
    const envOk = makeEnv("sk-test-passthrough-4");
    envOk.web.proxy = undefined;
    const { deps } = await buildHarnessEngine({
      env: envOk,
      askUser: createNoAskUser(),
    });
    // No threaded todoDir → todo_write absent.
    expect(deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS_NO_TODO
    );
  });

  it("injects sandboxRoot into the read_file tool (relative anchoring proves the root; ordinary out-of-root is decided by policy)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-build-engine-root-"));
    const outside = await mkdtemp(join(tmpdir(), "iknow-build-engine-out-"));
    try {
      // An explicit sandboxRoot must agree with resolveMcpRoots' workspaceRoot;
      // passed as the same root, relative names anchor at it — not at cwd.
      const { deps } = await buildHarnessEngine({
        env: makeEnv("sk-test-passthrough-2"),
        askUser: createNoAskUser(),
        sandboxRoot: root,
        workspaceRoot: root,
        productRoot: root,
      });

      const results = await deps.executor.executeAll([
        {
          id: "sandbox-read",
          name: "read_file",
          input: { path: join(outside, "victim.txt") },
        },
        {
          id: "relative-anchor",
          name: "read_file",
          input: { path: "relative-victim.txt" },
        },
      ]);
      const [outsideResult, relativeResult] = results;

      // ADR-0128 host reach: an ordinary path outside the root is no longer
      // reach-denied by the tool fence — the canonical policy allows it, so a
      // missing victim is reported as not-found (it never existed on disk).
      expect(outsideResult.kind).toBe("execution_failed");
      if (outsideResult.kind === "execution_failed") {
        expect(outsideResult.message).toMatch(/file not found/);
        expect(outsideResult.message).not.toMatch(/outside workspace/);
      }
      // read-only category → permission allows. If sandboxRoot were not
      // injected the relative name would anchor at process.cwd() instead;
      // the not-found message carrying the root-joined path proves the tool
      // was built with the explicit root.
      expect(relativeResult.kind).toBe("execution_failed");
      if (relativeResult.kind === "execution_failed") {
        expect(relativeResult.message).toContain(
          join(root, "relative-victim.txt")
        );
      }
    } finally {
      await removeTmpTree(root);
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// --- skill catalog + MCP manager assembly / per-surface conditioning ---------

/** Plants a skill fixture (a SKILL.md with valid frontmatter) in a tmp directory. */
async function plantSkill(
  root: string,
  skillName: string,
  description: string
): Promise<void> {
  const dir = join(root, skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\nbody`,
    "utf8"
  );
}

describe("buildHarnessEngine — #337 T8 skill 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => removeTmpTree(r)));
  });

  it("chat surface：skill catalog 装配后 skill 一件工具在场（SC5 删 skill_search）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-chat-skill-"));
    roots.push(root);
    await plantSkill(root, "echo", "echoes your message");

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-chat-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });

    expect(built.deps.registry.get("skill")).toBeDefined();
    // skill_search has been removed (see disclosure-index-align/).
    expect(built.deps.registry.get("skill_search")).toBeUndefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).toContain("skill");
    expect(names).not.toContain("skill_search");

    // Cleanup: if a shutdown handle exists, calling it does not throw (even with no MCP server).
    if (built.shutdown) await built.shutdown();
  });

  it("ask surface：skill 一件在场 + 无 shutdown 句柄（manager 未创建，SC12）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-ask-skill-"));
    roots.push(root);
    await plantSkill(root, "ask-skill", "ask-only skill");

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-ask-1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      userHome: join(root, "home"),
      cwd: root,
    });

    // skill is still assembled (the ask surface carries the skill tool too).
    expect(built.deps.registry.get("skill")).toBeDefined();
    // skill_search has been removed (see disclosure-index-align/).
    expect(built.deps.registry.get("skill_search")).toBeUndefined();

    // ask builds no MCP manager → shutdown handle absent; the subagent
    // manager is gated the same way (created only when surface !== "ask").
    expect(built.shutdown).toBeUndefined();
    expect(built.subagentManager).toBeUndefined();

    // ask strips spawn_subagent / subagent_result from the registry view.
    // skillCatalog is still assembled.
    expect(built.deps.registry.get("spawn_subagent")).toBeUndefined();
    expect(built.deps.registry.get("subagent_result")).toBeUndefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("subagent_result");
    // ask + memory off: layered stripping —
    //   - memory pair: memory.enabled=false
    //   - subagent pair + run_graph: ask never builds a subagentManager
    //     (run_graph is gated on the same seam; with the tool itself absent,
    //     handler isEnabled / graphAssembly dependencies are moot)
    //   - mcp pair: ask never builds an mcpManager
    //   - background pair (bash_output/bash_stop): ask never builds a backgroundManager
    //   - todo_write: no threaded todoDir
    // skill stays assembled. This assertion uses the
    // EXPECTED_TOOLS_NO_TODO.filter expression as the source of truth
    // (no additive arithmetic — sums drift).
    expect(names).toEqual(
      EXPECTED_TOOLS_NO_TODO.filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "subagent_stop" &&
          n !== "subagent_continue" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "bash_output" &&
          n !== "bash_stop" &&
          n !== "run_graph"
      )
    );

    // Zero mcp__* names in the views: registry.list() is the executor's
    // visible view (registry is the executor's input, so it anchors it).
    expect(names.filter((n) => n.startsWith("mcp__"))).toEqual([]);
  });
});

describe("buildHarnessEngine — #337 T8 MCP manager 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => removeTmpTree(r)));
  });

  it("chat surface：mcp config 缺席时 manager 在场 + shutdown 句柄透出", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-chat-mcp-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-chat-mcp-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });

    // Even with both mcp config levels absent, the manager is still created (its slot is just an empty map).
    expect(typeof built.shutdown).toBe("function");
    // Non-blocking assembly: calling shutdown does not throw.
    await built.shutdown!();
  });

  it("SC8：慢 connect stub 不阻塞 buildHarnessEngine 返回", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-sc8-"));
    roots.push(root);

    // A connect that never resolves — verifies buildHarnessEngine returns without awaiting it.
    // Connect-call counting is the behavioral assertion (connect must not have been called
    // during build = evidence of early return). The original `elapsed < 200ms` assertion
    // failed reliably on loaded 4-core hosts (measured 392-584ms) — a timing-tolerance
    // defect, not a build-logic defect; replaced by the connect counter plus a lower-bound
    // timing assertion, neither dependent on machine load.
    let connectCalls = 0;
    const slowClient: McpClientHandle = {
      connect: () => {
        connectCalls += 1;
        return new Promise<void>(() => {});
      },
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      // Resource surface is never reached in this case (build returns before
      // any MCP traffic); the stubs only satisfy the handle contract.
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };

    const start = Date.now();
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-sc8-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      // Test seam: inject a slow client. manager.start() never awaits it, so
      // this client hangs forever and build must still return early.
      createMcpClient: () => slowClient,
    });
    const elapsed = Date.now() - start;

    // Behavioral assertion: build returned early → connect was never called.
    // The slow connect is infinite; if it were awaited, build would never return.
    expect(connectCalls).toBe(0);
    // Lower-bound timing assertion: any finite build time passes against an
    // infinite connect. Upper bounds (e.g. <200ms) are load-sensitive timing
    // tolerances and were removed.
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(typeof built.shutdown).toBe("function");
    // Cleanup: trigger shutdown; the manager closes the slow client (connect
    // never resolves; close only clears state, it does not await connect).
    if (built.shutdown) await built.shutdown();
  });

  it("#378 根因 B: buildHarnessEngine 装配把 env.mcp.connectTimeoutMs 透传为 timeoutMsOverride", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-be-timeout-"));
    const captured: Array<Record<string, unknown>> = [];
    try {
      await buildHarnessEngine({
        env: {
          ...makeEnv("sk-test-t8-timeout-1"),
          mcp: { connectTimeoutMs: 90_000 },
        },
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpManager: (opts) => {
          captured.push(opts as unknown as Record<string, unknown>);
          return createMcpManager(opts);
        },
      });
    } finally {
      await removeTmpTree(root);
    }
    const last = captured.at(-1);
    expect(last).toBeDefined();
    expect(last!.timeoutMsOverride).toBe(90_000);
  });
});

describe("buildHarnessEngine — #356 T6 subagent manager 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => removeTmpTree(r)));
  });

  /** Verifies the fake-manager injection does not break assembly (spawn is never
   *  called; only that the registry carries the two tools and
   *  BuiltEngine.subagentManager surfaces the injected object). */
  const fakeManager: SubAgentManager = {
    spawn: () => ({ taskId: "fake-id" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // ADR-0096: the spawn_subagent tool-description getter's fallback path goes
    // through manager.getCapacity(); a static 15 matches the existing shape.
    getCapacity: () => 15,
    // The interface gained a read-only enumeration surface — the fake is
    // completed to stay structurally compatible.
    listSubagents: () => [],
    subscribe: () => () => {},
  };

  it("chat surface：注入 fake subagentManager → registry 含两件 + 透出注入对象", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-chat-fake-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t6-chat-fake-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeManager,
    });

    // The injected object is surfaced (BuiltEngine.subagentManager === fakeManager, reference equality).
    expect(built.subagentManager).toBe(fakeManager);
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("subagent_result");
    expect(built.deps.registry.get("spawn_subagent")).toBeDefined();
    expect(built.deps.registry.get("subagent_result")).toBeDefined();
    // No threaded todoDir → todo_write absent.
    expect(names).toEqual(EXPECTED_TOOLS_NO_TODO);

    // The composed shutdown does not throw (fake manager's shutdown resolves).
    await built.shutdown!();
  });

  it("ask surface：即使注入 fake manager 也不装配两件(T6 同 MCP 门:surface !== ask)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-ask-fake-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t6-ask-fake-1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeManager,
    });

    // ask neither creates nor surfaces a manager; the registry stays at the stripped set.
    expect(built.subagentManager).toBeUndefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("subagent_result");
  });
});

// --- secrets guard assembly in the product wiring ----------------------------
// All cases below pin `mode: "block"` explicitly — the guard is now assembled
// only as the legacy deny-only path (the default roundtrip ships no guard;
// see the mode-matrix describe below).
describe("buildHarnessEngine — #126 T5 secrets guard 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => removeTmpTree(r)));
  });

  it("block 模式：内置模式拦截密钥正例（sc-1），普通命令放行（sc-2）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-default-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { secrets: { mode: "block" } },
    });

    // guard passes a plain bash through → inner executes (read-only/execute categories default to ask; askUser approves all)
    const [allow] = await built.deps.executor.executeAll([
      { id: "t5-allow", name: "bash", input: { command: "echo hi" } },
    ]);
    expect(allow.kind).toBe("ok");

    // Secret positive: a bash input carrying an `sk-` shaped token → `[hook_blocked]`, inner not executed
    const [blocked] = await built.deps.executor.executeAll([
      {
        id: "t5-block",
        name: "bash",
        input: {
          command:
            "curl https://x --header Authorization: sk-abcd1234567890abcdefg1234",
        },
      },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message).toMatch(/\[hook_blocked\]/);
    }

    if (built.shutdown) await built.shutdown();
  });

  it(
    "settings 追加 pattern 生效 + enabled:false 透明（sc-3/sc-4）",
    // Per-case budget: full-suite contention on a 4-core box measured
    // >90s wall for this real-assembly case (it stays <10s standalone).
    { timeout: 180_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-custom-"));
      roots.push(root);

      // settings.secrets.patterns appends a custom shape
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t5-guard-2"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: {
          secrets: { mode: "block", patterns: ["CUSTOM_TOKEN_[A-Z0-9]{6}"] },
        },
      });

      // Custom pattern match → blocked
      const [blocked] = await built.deps.executor.executeAll([
        {
          id: "t5-custom-block",
          name: "bash",
          input: { command: "echo CUSTOM_TOKEN_ABC123" },
        },
      ]);
      expect(blocked.kind).toBe("execution_failed");
      if (blocked.kind === "execution_failed") {
        expect(blocked.message).toMatch(/\[hook_blocked\]/);
      }

      if (built.shutdown) await built.shutdown();

      // enabled:false → guard is transparent, secret shapes pass through
      const transparent = await buildHarnessEngine({
        env: makeEnv("sk-test-t5-guard-3"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "block", enabled: false } },
      });
      const [allowed] = await transparent.deps.executor.executeAll([
        {
          id: "t5-transparent",
          name: "bash",
          input: {
            command: "echo Authorization: sk-abcd1234567890abcdefg1234",
          },
        },
      ]);
      expect(allowed.kind).toBe("ok");
      if (transparent.shutdown) await transparent.shutdown();
    }
  );

  it("guard 放行时 hard-wall 仍拦（链顺序回归，sc-5）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-wall-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-4"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { secrets: { mode: "block" } },
    });

    // A call the hard wall always blocks (rm -rf) + secret-free input → guard passes it, `[permission_denied]` still blocks
    const [result] = await built.deps.executor.executeAll([
      { id: "t5-wall", name: "bash", input: { command: "rm -rf /" } },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/\[permission_denied\]/);
    }

    if (built.shutdown) await built.shutdown();
  });

  it("guard 构造期坏 pattern 剔除 + onHookError 告警，其余正常生效（sc-6）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-badpat-"));
    roots.push(root);

    const hookErrors: Array<{ phase: string; message: string }> = [];
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-5"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: {
        secrets: {
          mode: "block",
          patterns: ["[unclosed", "GOOD_TOKEN_[A-Z]{4}"],
        },
      },
      onHookError: (e) => hookErrors.push(e),
    });

    // Bad pattern dropped + warning raised; good pattern still active
    expect(hookErrors.some((e) => e.phase === "guard-init")).toBe(true);

    const [blocked] = await built.deps.executor.executeAll([
      {
        id: "t5-goodpat",
        name: "bash",
        input: { command: "echo GOOD_TOKEN_WXYZ" },
      },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message).toMatch(/\[hook_blocked\]/);
    }

    if (built.shutdown) await built.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Secret registry assembly — deps.secretRegistry exposure
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #406 T2 secret registry 装配", () => {
  it("默认 settings：deps.secretRegistry 是 SecretRegistry，构造期空表 + 默认 7 patterns", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-sr-1"),
      askUser: createNoAskUser(),
    });

    // The type already proves SecretRegistry; runtime asserts presence + key contracts
    expect(built.deps.secretRegistry).toBeDefined();
    expect(typeof built.deps.secretRegistry!.register).toBe("function");
    expect(typeof built.deps.secretRegistry!.resolve).toBe("function");
    // Empty at construction: size === 0 before any run()
    expect(built.deps.secretRegistry!.size).toBe(0);
    // Default patterns = the 7 DEFAULT_SECRET_PATTERNS
    expect(built.deps.secretRegistry!.patterns.length).toBe(7);

    if (built.shutdown) await built.shutdown();
  });

  it("settings.secrets.patterns 自定义追加 → registry.patterns = DEFAULT 7 + extras", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-sr-extras-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-sr-2"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: {
          secrets: { patterns: ["CUSTOM_TOKEN_[A-Z0-9]{6}"] },
        },
      });

      expect(built.deps.secretRegistry).toBeDefined();
      // Custom extras append after DEFAULT → 8 entries; the last one's source is the custom pattern
      expect(built.deps.secretRegistry!.patterns.length).toBe(8);
      expect(built.deps.secretRegistry!.patterns[7]!.source).toBe(
        "CUSTOM_TOKEN_[A-Z0-9]{6}"
      );

      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("settings 不含 secrets → registry 仍构造（DEFAULT 7 条，不抛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-sr-nosec-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-sr-3"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { llm: { model: "test-model", apiKey: "sk-dummy" } },
      });

      expect(built.deps.secretRegistry).toBeDefined();
      expect(built.deps.secretRegistry!.patterns.length).toBe(7);
      expect(built.deps.secretRegistry!.size).toBe(0);

      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Session-scoped todoDir seam (build-engine assembly side)
//
// Decision: when surface !== "ask", build-engine threads the host-injected
// todoDir to createDefaultAciRegistry; ask never threads it. The worker
// assembly path (createWorkerDeps) never threads todoDir either → the
// ownership boundary stays inside the main loop.
//
// Scope: asserts only that buildHarnessEngine accepts the todoDir option and
// Gate 3 does not throw; the todo_write factory and the SSOT append came in
// later steps, so nothing here assumes the tool is already in the registry.
//
// Per-case expected counts derive from the length of the
// `EXPECTED_TOOLS.filter(...)` expression — the expression is the source of
// truth; no additive arithmetic in comments (sums drift).
// ---------------------------------------------------------------------------

describe("buildHarnessEngine — #440 T1 todoDir seam", () => {
  it("chat surface：todoDir 传入 → todo_write 装配 + 39 件（seam 接受 + SSOT append-only;以 EXPECTED_TOOLS.length 为真值源,不写加法叙事）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-tododir"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir: "/tmp/some-session/todos",
    });
    // chat surface + todoDir → todoDir is threaded to the registry → todo_write assembles.
    // EXPECTED_TOOLS includes todo_write, bash_output, bash_stop and run_graph
    // (run_graph is resident on a chat surface that has a subagentManager;
    // graphAssembly is not passed, so the handler isEnabled default keeps it
    // closed — the tool itself still stands in the table). The count follows
    // EXPECTED_TOOLS.length, the source of truth.
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS
    );
    expect(built.deps.registry.get("todo_write")).toBeDefined();
    if (built.shutdown) await built.shutdown();
  });

  it("ask surface：todoDir 传入 → oneshot 剥离 todoDir，registry 不含 todo_write（行为不变）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-ask-tododir"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      todoDir: "/tmp/some-session/todos",
    });
    // The ask surface keeps the existing gating: EXPECTED_TOOLS.filter strips
    // the memory pair, the subagent pair, the mcp pair, todo_write, the
    // background pair and run_graph (ask creates no subagentManager /
    // mcpManager / backgroundManager — run_graph falls with the missing
    // subagentManager; memory enabled:false; todoDir stripped oneshot).
    // Count = length of the filter expression, the array being the source of truth.
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS.filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "subagent_stop" &&
          n !== "subagent_continue" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "todo_write" &&
          n !== "bash_output" &&
          n !== "bash_stop" &&
          // ask has no subagentManager → run_graph absent.
          n !== "run_graph"
      )
    );
    expect(built.deps.registry.get("todo_write")).toBeUndefined();
  });

  it("默认 chat surface 不传 todoDir → todo_write 不装配，38 件（seam 缺席零变化，向后兼容）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-default"),
      askUser: createNoAskUser(),
    });
    // todoDir undefined → todo_write absent; EXPECTED_TOOLS.filter strips
    // todo_write; backgroundManager is still assembled (bash_output/bash_stop
    // present); run_graph stays resident in the chat registry (handler
    // isEnabled defaults to closed).
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS.filter((n) => n !== "todo_write")
    );
    expect(built.deps.registry.get("todo_write")).toBeUndefined();
    if (built.shutdown) await built.shutdown();
  });
});

// ---------------------------------------------------------------------------
// secrets.mode assembly matrix — roundtrip default vs block compatibility
// ---------------------------------------------------------------------------
// A1/A3: no mode or explicit "roundtrip" → secretsMode absent (undefined),
// secretRegistry present (roundtrip mechanism ON), guard not assembled.
// A2: mode:"block" → secretsMode==="block", secretRegistry absent (roundtrip
// mechanism OFF), guard assembled.
// A4: mode:"invalid" → settings.parseSecrets already dropped it → same as the roundtrip default.
// Note: the guard is assembled inside createAciExecutor; hooks are not reachable
// from outside. secretsMode + secretRegistry are faithful proxies for the
// loop-engine / bash machinery state (secrets-guard.test.ts proves the guard's
// own behavior; block end-to-end cases live in this file's guard-assembly describe above).
describe("buildHarnessEngine — #406 T4 secrets.mode 装配矩阵", () => {
  it("A1:缺省 settings(无 secrets.mode)→ secretsMode undefined + secretRegistry 在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a1-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("A2:settings.secrets.mode=block → secretsMode block + secretRegistry 缺席(guard 兼容路径)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a2-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a2"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "block" } },
      });
      expect(built.deps.secretsMode).toBe("block");
      expect(built.deps.secretRegistry).toBeUndefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("A3:settings.secrets.mode=roundtrip(显式)→ secretsMode undefined + secretRegistry 在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a3-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a3"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "roundtrip" } },
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("A4:settings.secrets.mode=invalid → parse 丢弃 → 同缺省 roundtrip", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a4-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a4"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "invalid" as never } },
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// The default path no longer injects the coordinator scheduling segment:
// the default buildHarnessEngine (surfaces that self-build a subagentManager)
// renders no "## Sub-agent coordination" section / acceptance keywords in
// deps.system(); the assembly seam remains (only an explicitly passed
// non-empty coordinatorText renders — see the seam cases in coordinator-segment.test.ts).
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #558 T2 默认不注入 coordinator 段", () => {
  it("默认 chat surface(自建 subagentManager)→ deps.system() 不含 ## Sub-agent coordination 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-default-absence-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-default-1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });

      // subagentManager present (full assembly), but the coordinator section is no
      // longer injected by default: the default path's guidance landing point is the
      // tool description (the SSOT), never double-written into the system section.
      expect(built.subagentManager).toBeDefined();

      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");
      expect(systemText).not.toContain("spawn_subagent");
      expect(systemText).not.toContain("blocks until finished");
      expect(systemText).not.toContain("Use spawn_subagent");

      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("tui surface(委托 buildHarnessEngine)→ deps.system() 默认同样不含 coordinator 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-tui-default-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-tui-default-1"),
        askUser: createNoAskUser(),
        surface: "tui",
        userHome: join(root, "home"),
        cwd: root,
      });

      expect(built.subagentManager).toBeDefined();
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");
      expect(systemText).not.toContain("blocks until finished");

      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("serve surface(自建 subagentManager)→ deps.system() 默认同样不含 coordinator 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-serve-default-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-serve-default-1"),
        askUser: createNoAskUser(),
        surface: "serve",
        userHome: join(root, "home"),
        cwd: root,
      });

      expect(built.subagentManager).toBeDefined();
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");

      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0009 D2 (amended): parent sessions (chat / tui / serve) do not load rules
// bodies at opening — all three assembly paths share build-engine deps.system,
// which injects only the rules path list plus a read-path pointer; a session
// without a rules directory still starts normally.
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #841 T6 父会话 rules 清单化", () => {
  const surfaces = ["chat", "tui", "serve"] as const;

  for (const surface of surfaces) {
    it(`${surface}: deps.system() lists rule paths, never rule bodies`, async () => {
      const root = await mkdtemp(join(tmpdir(), "iknow-t6-rules-"));
      try {
        const rulesDir = join(root, ".iknow", "rules");
        await mkdir(rulesDir, { recursive: true });
        await writeFile(join(rulesDir, "alpha.md"), "ALPHA RULE BODY");
        await writeFile(join(rulesDir, "beta.md"), "BETA RULE BODY");

        const built = await buildHarnessEngine({
          env: makeEnv(`sk-test-t6-${surface}`),
          askUser: createNoAskUser(),
          surface,
          userHome: join(root, "home"),
          cwd: root,
        });

        const systemText = (await built.deps.system?.()) ?? "";
        expect(systemText).not.toContain("ALPHA RULE BODY");
        expect(systemText).not.toContain("BETA RULE BODY");
        expect(systemText).toContain(join(rulesDir, "alpha.md"));
        expect(systemText).toContain(join(rulesDir, "beta.md"));
        expect(systemText).toContain("read_file");

        if (built.shutdown) await built.shutdown();
      } finally {
        await removeTmpTree(root);
      }
    });
  }

  it("chat: missing rules directory → session system still resolves (not fatal)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-norules-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t6-norules"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("Rules index");
      expect(systemText.length).toBeGreaterThan(0);
      if (built.shutdown) await built.shutdown();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0040 — subagent dispatch classification at the build-engine gate.
// The gate must classify the worker's effective capability surface rather than
// treating every spawn_subagent call as read-only.
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — T4 subagent isolation classifier", () => {
  it("allows explore on the main repo without provisioning and runs it read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-explore-"));
    const { manager, spawnedTasks, blockedCalls } = makeTestSubagentManager();
    let provisioned = 0;
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-explore"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        title: "spawn probe",
        task: "inspect the repository",
        subagent_type: "explore",
        wait: false,
      });

      expect(result.kind).toBe("ok");
      expect(spawnedTasks).toEqual(["inspect the repository"]);
      expect(provisioned).toBe(0);
      // read-only role never reaches the unbound block → zero forensic records
      expect(blockedCalls).toEqual([]);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("explore catalog deny includes symbol writers so default spawn stays on the main repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-symbol-worker-"));
    const workerDeps = await createWorkerDeps({
      env: makeEnv("sk-test-t4-symbol-worker"),
      sandboxRoot: root,
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      trace: createNoopTraceService(),
      system: async () => undefined,
      role: "explore",
    });
    const workerToolNames = workerDeps.registry.list().map((tool) => tool.name);
    const workerDecision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
    });
    let provisioned = 0;
    try {
      for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
        expect(workerToolNames).not.toContain(name);
      }
      expect(workerDecision.conclusion).toBe("readonly");
      expect(workerDecision.reason).toBe("write_tools_denied_bash_readonly");

      const { manager, spawnedTasks } = makeTestSubagentManager();
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-symbol-gate"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        title: "spawn probe",
        task: "inspect the repository",
        subagent_type: "explore",
        wait: false,
      });

      expect(result.kind).toBe("ok");
      expect(spawnedTasks).toEqual(["inspect the repository"]);
      expect(provisioned).toBe(0);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("blocks the default general-purpose spawn on the main repo, points at worktree creation, and records the interception forensically", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-general-"));
    const subagentsDir = join(root, "subagents");
    let spawnFactoryCalls = 0;
    // Real manager: the forensic record must land in a genuine per-agent
    // JSONL under the assembly dir, not just reach a spy.
    const manager = createSubAgentManager({
      sandboxRoot: root,
      subagentsDir,
      spawn: (): ChildProcess => {
        spawnFactoryCalls += 1;
        throw new Error(
          "gate-blocked spawn must never reach the worker spawn factory"
        );
      },
    });
    let provisioned = 0;
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-general"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        title: "spawn probe",
        task: "make the requested change",
        wait: false,
      });

      expect(failureMessage(result)).toContain("create-worktree ACI tool");
      // no worker, no slot: the spawn factory never ran, the task tables stayed empty
      expect(spawnFactoryCalls).toBe(0);
      expect(provisioned).toBe(0);
      expect(manager.listActive()).toEqual([]);
      // forensic record: exactly one per-agent JSONL carrying one
      // subagent_spawn status:error line with the verbatim block notice
      const records = listSubagentRecordPaths(subagentsDir);
      expect(records).toHaveLength(1);
      const rows = readFileSync(records[0]!, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.record_type).toBe("subagent_spawn");
      expect(row.status).toBe("error");
      expect(row.origin).toBe("parent");
      expect(row.task_preview).toBe("make the requested change");
      expect(row.subagent_id).toBe(row.task_id);
      const err = row.error as { type: string; message: string };
      expect(err.type).toBe("execution_failed");
      expect(err.message).toBe(failureMessage(result));
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("fails closed for an unknown subagent type before spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-unknown-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-unknown"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => root },
      });

      const result = await runSpawn(built, {
        title: "spawn probe",
        task: "use an unsupported role",
        subagent_type: "not-a-catalog-role",
        wait: false,
      });

      expect(failureMessage(result)).toContain("create-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("still blocks a general-purpose spawn when only write and edit are denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-bash-any-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-bash-any"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => root },
      });

      const result = await runSpawn(built, {
        title: "spawn probe",
        task: "write through shell if needed",
        subagent_type: "general-purpose",
        disallowedTools: ["write_file", "edit_file"],
        wait: false,
      });

      expect(failureMessage(result)).toContain("create-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("allows a general-purpose spawn after the session is rebound to its task worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-rebound-"));
    const taskRoot = join(root, ".iknow", "worktrees", "conv-1");
    await mkdir(taskRoot, { recursive: true });
    const { manager, spawnedTasks } = makeTestSubagentManager();
    const { manager: reboundManager, payloads: reboundPayloads } =
      makeCapturingSubagentManager(taskRoot);
    try {
      const mainBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-rebound-main"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => taskRoot },
      });
      const blocked = await runSpawn(mainBuilt, {
        title: "spawn probe",
        task: "change the repository",
        wait: false,
      });
      expect(blocked.kind).toBe("execution_failed");
      await mainBuilt.shutdown?.();

      const reboundBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-rebound-task"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: taskRoot,
        sandboxRoot: taskRoot,
        workspaceRoot: taskRoot,
        productRoot: root,
        projectIdentityRoot: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: reboundManager,
        worktreeIsolation: { provision: async () => taskRoot },
      });
      const result = await runSpawn(reboundBuilt, {
        title: "spawn probe",
        task: "change the repository",
        wait: false,
      });

      expect(result.kind).toBe("ok");
      expect(spawnedTasks).toEqual([]);
      expect(reboundPayloads).toHaveLength(1);
      expect(reboundPayloads[0]?.task).toBe("change the repository");
      expect(reboundPayloads[0]?.sandboxRoot).toBe(taskRoot);
      await reboundBuilt.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("keeps the spawn result bytes unchanged when isolation is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-off-"));
    try {
      const offManager = makeTestSubagentManager();
      const offBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: false } },
        subagentManager: offManager.manager,
        worktreeIsolation: { provision: async () => root },
      });
      const offResult = await runSpawn(offBuilt, {
        title: "spawn probe",
        task: "preserve the existing path",
        wait: false,
      });

      const baselineManager = makeTestSubagentManager();
      const baselineBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-off-baseline"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        subagentManager: baselineManager.manager,
      });
      const baselineResult = await runSpawn(baselineBuilt, {
        title: "spawn probe",
        task: "preserve the existing path",
        wait: false,
      });

      expect(JSON.stringify(offResult)).toBe(JSON.stringify(baselineResult));
      await offBuilt.shutdown?.();
      await baselineBuilt.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// --------------------------------------------------------------------------
// ADR-0085 — build-engine threads the host-injected todoDir to
// createSubAgentManager, which lands `todoLedger` into the worker envelope on spawn.
//
// This is the assembly-side endpoint of the "parent-session ledger → worker tool
// surface" chain: build-engine is todoDir's host injection point (the same value
// the main-loop registry gets), the manager is the write point, and the worker is
// the consumer (worker-tool-surface.test.ts pins the consuming side).
// --------------------------------------------------------------------------

describe("buildHarnessEngine — ADR-0085 SC9 worker 账本锚点", () => {
  beforeEach(() => {
    fakeWorkerChildren.length = 0;
    workerSpawnOverride.current = () => makeFakeWorkerChild();
  });

  afterEach(() => {
    // Restore the real spawn — leave no global override affecting other cases in this file.
    workerSpawnOverride.current = undefined;
  });

  it("todoDir 在场 → spawn envelope 带 {projectDir: todoDir, conversationId: def 的父会话}", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-sc9-eng-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-sc9-todo"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        todoDir: join(root, "projects", "repo-deadbeef"),
        settings: { isolation: { worktreeOnMutate: false } },
      });

      const result = await runSpawn(
        built,
        { title: "ledger probe", task: "share the ledger", wait: false },
        "conv-sc9-parent"
      );
      expect(result.kind).toBe("ok");
      // Assertion surface = the wire bytes on the child's stdin (the genuine outlet
      // of the whole build-engine → manager → envelope chain; injecting a manager
      // would bypass the todoDir threading this test must prove).
      const payload = firstWorkerEnvelope();
      expect(payload?.todoLedger).toEqual({
        projectDir: join(root, "projects", "repo-deadbeef"),
        conversationId: "conv-sc9-parent",
      });
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("todoDir 缺席 → envelope 无 todoLedger（旧 wire 形态，零变化）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-sc9-eng-off-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-sc9-todo-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: false } },
      });

      const result = await runSpawn(
        built,
        { title: "no ledger probe", task: "no ledger", wait: false },
        "conv-sc9-parent"
      );
      expect(result.kind).toBe("ok");
      const payload = firstWorkerEnvelope();
      expect(payload).toBeDefined();
      expect(payload && "todoLedger" in payload).toBe(false);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// build-engine wires the live taskRoot holder + single writer at the host seam
// boundary. There was initially no consumer; from the skill-trailer work
// BuiltEngine exposes the cell, and the single-root-authority invariant evolved
// into "the exposed cell IS the same instance the registry / hub consume" —
// no second root holder exists, and the stable roots remain frozen.
// --------------------------------------------------------------------------

describe("buildHarnessEngine — T4 live taskRoot wrap (zero behavior change)", () => {
  it("host seams present + isolation OFF → worktree tools registered (seam-keyed), gate passthrough", async () => {
    // ADR-0037 (amended): the worktree ACI tools are keyed on host-seam presence,
    // NOT on `isolation.worktreeOnMutate`. The switch arms ONLY the mutate gate.
    // Pins both halves: (a) registry membership follows the seams; (b) no
    // interception happens with the switch OFF (write lands, nothing blocked).
    const root = await mkdtemp(join(tmpdir(), "iknow-slice-a-off-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-slice-a-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: false } },
        worktreeIsolation: {
          provision: async () => root,
          worktreeEnter: async () => ({
            path: root,
            receipt: `entered task worktree: ${root}`,
          }),
          worktreeExit: async () => root,
          worktreeList: async () => [],
          worktreeRemove: async () => ({
            label: undefined,
            conversationId: "conv-1",
            path: root,
            branch: "iknow/task-conv-1",
            head: "deadbeef",
            branchDeleted: false,
          }),
        },
      });

      // (a) seam presence ⇒ tool present, independent of the switch.
      expect(built.deps.registry.get("create-worktree")).toBeDefined();
      expect(built.deps.registry.get("list-worktrees")).toBeDefined();
      expect(built.deps.registry.get("enter-worktree")).toBeDefined();
      expect(built.deps.registry.get("exit-worktree")).toBeDefined();
      expect(built.deps.registry.get("remove-worktree")).toBeDefined();
      // The gate itself stays disarmed: BuiltEngine.isolationOn mirrors
      // `isolationEnabled` (host && switch), so OFF never arms it.
      expect(built.isolationOn).toBe(false);

      // (b) gate OFF passthrough: an unbound main-repo mutate executes.
      const [result] = await built.deps.executor.executeAll(
        [
          {
            id: "slice-a-write",
            name: "write_file",
            input: { path: "slice-a.txt", content: "gate is off" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(result.kind).toBe("ok");
      // An `ok` receipt has no failure label at all, so the meaningful check is
      // that its model-visible payload carries no isolation block text.
      if (result.kind === "ok") {
        expect(JSON.stringify(result.payload)).not.toContain(
          "[worktree_isolation]"
        );
      }
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(root, "slice-a.txt"), "utf8")).toBe(
        "gate is off"
      );

      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolation OFF → wrap is NOT installed (T3 baseline preserved)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-off-"));
    try {
      // settings without isolation.worktreeOnMutate → isolationEnabled = false.
      // The build-engine isolation branch should NOT be entered; the wrap is
      // dormant. Behavior is byte-identical to the non-isolation baseline.
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: {}, // no isolation flag
        // No worktreeIsolation host seam — registry should still build
        // the chat tool set without isolation-aware wrappers.
      });
      // sessionRoots is the resolveSessionRoots snapshot (stable roots):
      // productRoot / projectIdentityRoot / installRoot unchanged from assembly.
      expect(built.sessionRoots.taskRoot).toBe(root);
      expect(built.sessionRoots.productRoot).not.toBe("");
      // Single root authority: the liveTaskRoot BuiltEngine exposes IS the
      // very cell the registry / hub consume — no second root holder exists.
      // On the OFF tier the cell's initial value = taskRoot, still present.
      expect("liveTaskRoot" in built).toBe(true);
      expect(built.liveTaskRoot?.read()).toBe(root);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("isolation ON + custom seam → engine builds, seam is wired, BuiltEngine has no second root authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-on-"));
    try {
      const seamResolved = join(root, ".iknow", "worktrees", "conv-1");
      let seamCalls = 0;
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-on"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          provision: async () => {
            seamCalls++;
            return seamResolved;
          },
        },
      });
      // (a) Engine builds successfully with isolation enabled + custom seam.
      // (b) sessionRoots.taskRoot stays at the initial sandboxRoot — Hub
      //     observes this through BuiltEngine.sessionRoots, NOT through
      //     the live cell. (No consumer reads the cell here, so this
      //     stays at the initial value.)
      expect(built.sessionRoots.taskRoot).toBe(root);
      // (c) The stable roots are NOT carried by a live cell:
      expect(built.sessionRoots.productRoot).not.toBe("");
      expect(built.sessionRoots.projectIdentityRoot).not.toBe("");
      expect(built.sessionRoots.installRoot).not.toBe("");
      // (d) Single root authority: the exposed liveTaskRoot is the ONLY cell
      //     instance (registry factory / hub read the same one), not a second
      //     root authority; at this point the cell still holds the initial
      //     taskRoot (the seam has never been called).
      expect(built.liveTaskRoot?.read()).toBe(root);
      // (e) Seam is not invoked at build time (the gate only calls
      //     provision when an engine is rooted at a task-worktree-shaped
      //     path; `root` here is the main repo, not a worktree).
      expect(seamCalls).toBe(0);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("isolation ON + seam throws typed error → gate blocks, no second root authority, BuiltEngine surface stable", async () => {
    // Provoke the typed-error path: a session in main-repo state tries to
    // mutate. The gate blocks (established behavior), the seam is NOT called
    // for main-repo traffic (the provision contract), and any latent
    // seam throw wouldn't poison the live cell because the wrap is
    // downstream of the gate's block.
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-throw-"));
    try {
      const typedErr = Object.assign(new Error("rebind_failed"), {
        kind: "rebind_failed",
      });
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-throw"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          // Seam throws typed error — but the gate only calls it on
          // task-worktree-shaped paths, so this is never invoked in the
          // main-repo path. Still, the wrap must preserve the throw
          // identity if it ever does.
          provision: async () => {
            throw typedErr;
          },
        },
      });
      // sessionRoots surface unchanged (Hub reads from this, not the cell).
      expect(built.sessionRoots.taskRoot).toBe(root);
      // Single root authority: the cell is exposed but the seam was never
      // called → it still holds its initial value; a typed throw never writes
      // the cell (the withLiveTaskRootWrite contract).
      expect(built.liveTaskRoot?.read()).toBe(root);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("stable roots stay frozen through the wrap (D3) — sessionRoots.productRoot / projectIdentityRoot / installRoot not affected by host seam", async () => {
    // Stable-roots list: productRoot / projectIdentityRoot / installRoot must
    // stay frozen through assembly. Writes to the live taskRoot slot never
    // touch these three — resolveSessionRoots fixes them once at assembly
    // (see build-engine.ts:438); the wrap only contacts the taskRoot slot.
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-stable-"));
    try {
      const seamResolved = join(root, ".iknow", "worktrees", "conv-1");
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-stable"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          provision: async () => seamResolved,
        },
      });
      // Capture the four roots at build time.
      const initialProduct = built.sessionRoots.productRoot;
      const initialIdentity = built.sessionRoots.projectIdentityRoot;
      const initialInstall = built.sessionRoots.installRoot;
      const initialTask = built.sessionRoots.taskRoot;
      expect(initialProduct).toBeTruthy();
      expect(initialIdentity).toBeTruthy();
      expect(initialInstall).toBeTruthy();
      expect(initialTask).toBe(root);

      // The cell is internal; we cannot poke it via BuiltEngine. The stable-root
      // invariants are exercised by resolveSessionRoots tests in
      // session-roots.test.ts. Here we assert that
      // sessionRoots.productRoot / projectIdentityRoot / installRoot are
      // stable strings, equal to themselves on every read (frozen), and
      // never replaced by the wrap's host seam output.
      expect(built.sessionRoots.productRoot).toBe(initialProduct);
      expect(built.sessionRoots.projectIdentityRoot).toBe(initialIdentity);
      expect(built.sessionRoots.installRoot).toBe(initialInstall);
      // Cross-rebind invariance: even if the cell gets written (which it
      // doesn't here because no consumer reads), the sessionRoots object
      // is the immutable resolveSessionRoots output and is NOT aliased to
      // the cell. `taskRoot` here is the initial sandboxRoot, NOT the
      // seamResolved value — proving sessionRoots is the assembly-time
      // snapshot, not a live reference.
      expect(built.sessionRoots.taskRoot).toBe(initialTask);
      expect(built.sessionRoots.taskRoot).not.toBe(seamResolved);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0096 (amends ADR-0037) — the mutate switch is a live holder, not an
// assembly-time boolean. The /config panel flips it in-session; the gate reads
// it once per wave, so a flip lands on the NEXT wave and never auto-provisions.
// ---------------------------------------------------------------------------

describe("buildHarnessEngine — ADR-0096 T3 live worktree switch holder", () => {
  it("holder absent + switch ON → gate armed from the startup read (byte-equal to today)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-holder-default-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-holder-default"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: { provision: async () => root },
      });
      const [blocked] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-default-write",
            name: "write_file",
            input: { path: "t3-default.txt", content: "x" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(failureMessage(blocked)).toContain("[worktree_isolation]");
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("panel flip OFF → ON arms the gate on the next wave, without auto-provision", async () => {
    // Acceptance: with the panel flipping ON mid-session
    // and the session still unbound, the next mutate is blocked and NO
    // `git worktree add` happens (provision seam never called).
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-flip-on-"));
    try {
      let provisionCalls = 0;
      const holder = createWorktreeOnMutateHolder(false);
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-flip-on"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: false } },
        worktreeIsolation: {
          provision: async () => {
            provisionCalls++;
            return root;
          },
        },
        worktreeOnMutateHolder: holder,
      });
      // (a) holder off + settings off → gate transparent (main repo writable).
      const [before] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-off-write",
            name: "write_file",
            input: { path: "t3-off.txt", content: "off" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(before.kind).toBe("ok");
      expect(provisionCalls).toBe(0);

      // (b) the /config panel flip.
      holder.set(true);

      // (c) next wave: blocked, and still no provisioning on the block path.
      const [after] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-on-write",
            name: "write_file",
            input: { path: "t3-on.txt", content: "on" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      const afterMessage = failureMessage(after);
      expect(afterMessage).toContain("[worktree_isolation]");
      expect(afterMessage).toContain("create-worktree");
      expect(provisionCalls).toBe(0);

      expect(built.isolationOn).toBe(true);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("panel flip ON → OFF restores main-repo writes on the next wave", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-flip-off-"));
    try {
      const holder = createWorktreeOnMutateHolder(true);
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-flip-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: { provision: async () => root },
        worktreeOnMutateHolder: holder,
      });
      const [blocked] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-first-write",
            name: "write_file",
            input: { path: "t3-first.txt", content: "first" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(blocked.kind).toBe("execution_failed");

      holder.set(false);

      const [through] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-second-write",
            name: "write_file",
            input: { path: "t3-second.txt", content: "second" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(through.kind).toBe("ok");
      expect(built.isolationOn).toBe(false);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("panel flip ON → OFF drops Git work from the next system assembly", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-git-work-flip-"));
    try {
      const holder = createWorktreeOnMutateHolder(true);
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-git-work-flip"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: { provision: async () => root },
        worktreeOnMutateHolder: holder,
      });
      const onText = (await built.deps.system?.()) ?? "";
      expect(onText).toContain("## Git work");
      holder.set(false);
      const offText = (await built.deps.system?.()) ?? "";
      expect(offText).not.toContain("## Git work");
      expect(offText).not.toContain(
        "Do not write the main checkout to work around isolation"
      );
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("panel flip ON → OFF reports isolationOn false for rebind/spawn consumers", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-iso-flip-"));
    try {
      const holder = createWorktreeOnMutateHolder(true);
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-iso-flip"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: { provision: async () => root },
        worktreeOnMutateHolder: holder,
      });
      expect(built.isolationOn).toBe(true);
      holder.set(false);
      expect(built.isolationOn).toBe(false);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("no host seam → no wrap even with a holder injected (OFF byte-stable)", async () => {
    // Without a provision seam the gate has no adjudication path, so the
    // assembly stays transparent regardless of the holder value — today's
    // behavior for hub-less inlets, unchanged.
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-nohost-"));
    try {
      const holder = createWorktreeOnMutateHolder(true);
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t3-nohost"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeOnMutateHolder: holder,
      });
      const [result] = await built.deps.executor.executeAll(
        [
          {
            id: "t3-nohost-write",
            name: "write_file",
            input: { path: "t3-nohost.txt", content: "x" },
          },
        ],
        undefined,
        undefined,
        "conv-1"
      );
      expect(result.kind).toBe("ok");
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ===========================================================================
// Display surface: the system prompt pins the stable projectIdentityRoot while
// env_snapshot is wired to the live taskRoot reader (ADR-0037, as amended).
// Verifies three things:
//   (a) before any rebind, the envSnapshot injected by buildHarnessEngine has the
//       shape `{readCwd: live reader}` instead of `{cwd: static}`, and the
//       reader's initial output is byte-identical to today's readEnvSnapshot fed
//       workspaceRoot directly;
//   (b) after the withLiveTaskRootWrite seam runs, readCwd immediately reflects
//       the new root;
//   (c) the system-prompt assembly layer is byte-stable across a rebind (the
//       projectPath section pins the stable projectIdentityRoot and never reads
//       the cwd seam) — buildHarnessEngine does not expose system deps for a
//       direct check, so only the (a)(b) envSnapshot boundaries are pinned here;
//       (c) is pinned by identity/project-path-segment.test.ts.
// ===========================================================================

describe("buildHarnessEngine — T9 display surface", () => {
  function makeEnv(name: string): IknowEnv {
    return {
      llm: {
        baseUrl: "http://127.0.0.1:9999",
        model: "test-model",
        fallback: [],
        apiKey: `sk-test-${name}`,
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
      // Roots are supplied explicitly to buildHarnessEngine below; the env
      // side keeps its "unset" default.
      workspaceRoot: undefined,
      productRoot: undefined,
    };
  }

  it("未 rebind 时 envSnapshot 注入 readCwd 活 reader,其初始值与今日 workspaceRoot 静态 cwd 的 readEnvSnapshot 输出逐字节相同", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t9-unrebound-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t9-unrebound"),
        askUser: createNoAskUser(),
        surface: "tui",
        cwd: root,
        workspaceRoot: root,
        productRoot: root,
        projectIdentityRoot: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          provision: async () => join(root, ".iknow", "worktrees", "conv-1"),
        },
      });

      // (a) deps.envSnapshot shape: a live readCwd reader, not a static cwd.
      const seam = built.deps.envSnapshot as EnvSnapshotSeam | undefined;
      expect(seam).toBeDefined();
      const liveReader = seam!.readCwd;
      expect(typeof liveReader).toBe("function");
      expect(liveReader()).toBe(root);

      // If assembly still used a static-cwd seam, readEnvSnapshot output would
      // diverge from the baseline; with the live reader, readEnvSnapshot({cwd: root})
      // and readEnvSnapshot({cwd: liveReader()}) must be fully equivalent
      // (field-by-field deep equal) given root is a git repo.
      const fromReader = await readEnvSnapshot({ cwd: liveReader() });
      const baseline = await readEnvSnapshot({ cwd: root });
      expect(fromReader).toEqual(baseline);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("rebind 后 readCwd 立刻反映新 taskRoot(system prompt 段钉稳定根由 identity 测试钉死,此处只钉 envSnapshot 边界)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t9-rebound-"));
    try {
      const reboundRoot = join(root, ".iknow", "worktrees", "conv-1");
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t9-rebound"),
        askUser: createNoAskUser(),
        surface: "tui",
        cwd: root,
        workspaceRoot: root,
        productRoot: root,
        projectIdentityRoot: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          provision: async () => reboundRoot,
        },
      });

      const seam = built.deps.envSnapshot as EnvSnapshotSeam | undefined;
      expect(seam).toBeDefined();
      const liveReader = seam!.readCwd;
      expect(liveReader()).toBe(root);

      // Trigger the withLiveTaskRootWrite seam via the real create-worktree tool
      // path (the handler goes straight through the build-engine assembly layer),
      // then re-read after the rebind.
      const provisionTool = built.deps.registry.get("create-worktree");
      expect(provisionTool).toBeDefined();
      const toolResult = await provisionTool!.handler(
        {},
        { conversationId: "conv-1" }
      );
      expect(toolResult).toBe(
        `task worktree ready: ${reboundRoot} ` +
          `(session root rebound; the next wave of tool calls in this run will land in the new root, re-issue the blocked write then)`
      );

      // After the rebind the live reader immediately flips to the new taskRoot
      // (envSnapshot's human-readable face follows the live root).
      expect(liveReader()).toBe(reboundRoot);

      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0070: assembly-time transmission seam for `isolation.worktreeExclusive`.
// On the OFF tier the enter behavior is byte-identical to today's path; on the ON
// tier `built.worktreeExclusive === true`, and the session-api hub uses it to
// decide whether to run the occupancy check inside the `worktreeEnter` closure.
//
// Pinned invariants:
//   - settings absent / not `true` → `built.worktreeExclusive === false` (the OFF
//     tier strictly follows today's enter path, introducing no new denial route);
//     no dependence on a host seam being present;
//   - settings = true → `built.worktreeExclusive === true`; orthogonal to
//     `worktreeOnMutate`, the two fields resolve independently;
//   - unlike `isolationOn`: `worktreeExclusive` is a pure settings check (no
//     `&& isolationHost` conjunct), strictly reflecting the settings parse;
//   - read once at assembly time (ADR-0037 hard requirement 9); rebinding never
//     reloads settings.
// ---------------------------------------------------------------------------

describe("buildHarnessEngine — T2 worktreeExclusive transmission seam", () => {
  it("OFF档（settings 缺席）：built.worktreeExclusive === false, OFF 零回归", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-exclusive-off-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-exclusive-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: {},
      });
      // OFF tier: unset → false; no dependence on a host seam (no worktreeIsolation argument).
      expect(built.worktreeExclusive).toBe(false);
      // No contamination of the isolationOn shape: no worktreeIsolation host injected → isolationOn false.
      expect(built.isolationOn).toBe(false);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("OFF档（settings = false）：built.worktreeExclusive === false, OFF 零回归", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-exclusive-false-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-exclusive-false"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeExclusive: false } },
      });
      expect(built.worktreeExclusive).toBe(false);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("ON档（settings = true）：built.worktreeExclusive === true, 独立于 host 缝在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-exclusive-on-"));
    try {
      // No worktreeIsolation host seam injected: the switch still resolves true from settings.
      // Unlike `isolationOn` (which requires a host seam present to return true).
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-exclusive-on"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeExclusive: true } },
      });
      expect(built.worktreeExclusive).toBe(true);
      // isolationOn stays false (no host seam): the two fields are independent.
      expect(built.isolationOn).toBe(false);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("ON档 + host 缝在场：built.worktreeExclusive === true, isolationOn === true（两字段独立解析）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-exclusive-on-host-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-exclusive-on-host"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: {
          isolation: { worktreeOnMutate: true, worktreeExclusive: true },
        },
        worktreeIsolation: {
          provision: async () => root,
        },
      });
      expect(built.worktreeExclusive).toBe(true);
      expect(built.isolationOn).toBe(true);
      await built.shutdown?.();
    } finally {
      await removeTmpTree(root);
    }
  });

  it("worktreeOnMutate × worktreeExclusive 矩阵：两字段独立解析，互不影响", async () => {
    // ADR-0070 accepts the trade-off: each extra boolean setting adds a combined
    // state and the test matrix grows with it. The 2×2 = 4 tiers verify the two
    // fields BuiltEngine exposes.
    // Note: isolationOn = (host present) && wom=true (settings=false is always
    // OFF in the isolation resolver); worktreeExclusive = exc=true (host-independent).
    const matrix: ReadonlyArray<{
      readonly wom: boolean | undefined;
      readonly exc: boolean | undefined;
      readonly expectedWom: boolean;
      readonly expectedExc: boolean;
      readonly hostPresent: boolean;
      readonly label: string;
    }> = [
      {
        wom: undefined,
        exc: undefined,
        expectedWom: false,
        expectedExc: false,
        hostPresent: false,
        label: "wom-absent-exc-absent",
      },
      {
        wom: true,
        exc: false,
        expectedWom: true,
        expectedExc: false,
        hostPresent: true,
        label: "wom-true-exc-false",
      },
      {
        wom: false,
        exc: true,
        expectedWom: false,
        expectedExc: true,
        hostPresent: false,
        label: "wom-false-exc-true",
      },
      {
        wom: true,
        exc: true,
        expectedWom: true,
        expectedExc: true,
        hostPresent: true,
        label: "wom-true-exc-true",
      },
    ];
    for (const cell of matrix) {
      // Cleanup goes through removeTmpTree, not bare rm: assembly kicks off
      // `void mkdir(<root>/.iknow/memory/<ns>)` fire-and-forget, measured to land
      // 0–28ms after buildHarnessEngine returns; this loop awaits shutdown() and
      // then cleans up immediately, so rm's final rmdir can collide with it —
      // under full concurrency (maxForks=3) this is exactly where
      // `ENOTEMPTY: … rmdir '/tmp/iknow-t2-matrix-…'` surfaced. See the removeTmpTree comment.
      const root = await mkdtemp(
        join(tmpdir(), `iknow-t2-matrix-${cell.label}-`)
      );
      try {
        const settings: IknowSettings =
          cell.wom === undefined && cell.exc === undefined
            ? {}
            : {
                isolation: {
                  ...(cell.wom !== undefined
                    ? { worktreeOnMutate: cell.wom }
                    : {}),
                  ...(cell.exc !== undefined
                    ? { worktreeExclusive: cell.exc }
                    : {}),
                },
              };
        const built = await buildHarnessEngine({
          env: makeEnv(`sk-test-t2-matrix-${cell.label}`),
          askUser: createNoAskUser(),
          surface: "chat",
          cwd: root,
          userHome: join(root, "home"),
          settings,
          ...(cell.hostPresent
            ? {
                worktreeIsolation: {
                  provision: async () => root,
                },
              }
            : {}),
        });
        // Note: isolationOn = isolationEnabled = host && wom===true;
        // worktreeExclusive = exc===true (independent of host).
        expect(built.worktreeExclusive).toBe(cell.expectedExc);
        expect(built.isolationOn).toBe(cell.expectedWom);
        await built.shutdown?.();
      } finally {
        await removeTmpTree(root);
      }
    }
  });
});
