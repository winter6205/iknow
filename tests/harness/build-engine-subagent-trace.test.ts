/**
 * build-engine's subagentsDir injection seam (ADR-0071), covering the
 * production assembly surface (cli.ts chat path + hub.ts ensureDeps).
 *
 * Contract:
 *   1. buildHarnessEngine({ subagentsDir }) → the builtin
 *      createSubAgentManager receives that subagentsDir; after triggering a
 *      spawn via the fake spawn factory, real JSONL lands at
 *      `<subagentsDir>/agent-<taskId>.jsonl` containing three event types.
 *   2. Absent subagentsDir → the manager falls back to NoopTraceService
 *      (byte-stable, equivalent to the old default subagentTrace shape).
 *
 * Difference from tests/subagent/manager-trace.test.ts: that file constructs
 * the manager directly with an injected trace + fake spawn factory; this one
 * verifies build-engine's assembly chain — opts.subagentsDir reaching the
 * manager.
 *
 * Mock strategy: vi.mock the whole module (sync fake via `vi.hoisted` shared
 * state) so build-engine.ts's `import { createSubAgentManager }` resolves to
 * the spy, and the spy swaps the spawn factory for a fake (no real worker).
 * Under ESM live bindings, vi.spyOn(module, "createSubAgentManager") only
 * mutates the namespace, not the import binding (see the comment in
 * tests/harness/aci/registry-workspace-root.test.ts); a module-level vi.mock
 * is the correct interception point.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { McpClientHandle } from "../../src/harness/mcp/manager.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";

// Isolate the repo-root .mcp.json's iknow-trace server (its schema-compile
// validator is unreachable in the unit-test environment, and the resulting
// 30s assembly window plus tsx child-process noise are side effects of the
// same dependency surface) — through build-engine's existing
// createMcpManager / createMcpClient test seams. Also stub the real SDK
// countTokens network call (127.0.0.1:9999 is a dead port). Other MCP shapes
// stay untouched. Stub scope vs. still-real invariants: trace injection /
// NoopTrace default / diagnosticsDir pass-through / query_trace reading the
// diagnosticsDir tree.
const fakeMcpClient = (_server: unknown): McpClientHandle => ({
  connect: async () => {},
  listTools: async () => [],
  callTool: async () => ({ result: { content: [] } }) as never,
  close: async () => {},
  onListChanged: () => {},
  onClose: () => {},
  listResources: async () => ({ resources: [] }),
  readResource: async () => ({ contents: [] }),
});

// The module mock must precede buildHarnessEngine's dynamic import.
// vi.hoisted shared state resolves the ordering between the hoisted vi.mock
// factory and the fakeChildren variable declaration.
const mockState = vi.hoisted(() => ({
  fakeChildren: [] as Array<{
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    emit: (event: string | symbol, ...args: unknown[]) => boolean;
    once: (event: string | symbol, ...args: unknown[]) => unknown;
  }>,
  captureCallCount: 0,
  capturedTraceOpt: undefined as unknown,
  capturedSubagentsDir: undefined as unknown,
  capturedDiagnosticsDir: undefined as unknown,
}));

vi.mock("../../src/harness/subagent/manager.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/harness/subagent/manager.ts")
    >();
  const realCreate = actual.createSubAgentManager;
  return {
    ...actual,
    createSubAgentManager: vi.fn((opts: Parameters<typeof realCreate>[0]) => {
      mockState.captureCallCount += 1;
      mockState.capturedTraceOpt = opts.trace;
      mockState.capturedSubagentsDir = opts.subagentsDir;
      mockState.capturedDiagnosticsDir = opts.diagnosticsDir;
      const fakeSpawn: (
        def: unknown,
        taskId: string,
        payload: unknown
      ) => ChildProcess = (_def, _taskId, _payload) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const kill = vi.fn(() => true);
        const child = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr,
          pid: 12345,
          kill,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
        });
        mockState.fakeChildren.push(
          child as unknown as (typeof mockState.fakeChildren)[number]
        );
        return child as unknown as ChildProcess;
      };
      return realCreate({
        ...opts,
        spawn: fakeSpawn as never,
      });
    }),
  };
});

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

// ── env fixture ─────────────────────────────────────────────────────────

function makeEnv(apiKey: string): IknowEnv {
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
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
  };
}

function okEnvelope(result = "ok"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(
  child: (typeof mockState.fakeChildren)[number],
  env: SubAgentEnvelope
): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

// ── per-test isolation ─────────────────────────────────────────────────

let scratchDir: string;
let built: BuiltEngine | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "iknow-bld-subagent-trace-"));
  mockState.fakeChildren.length = 0;
  mockState.captureCallCount = 0;
  mockState.capturedTraceOpt = undefined;
  mockState.capturedSubagentsDir = undefined;
  mockState.capturedDiagnosticsDir = undefined;
});

afterEach(async () => {
  if (built) {
    await built.shutdown?.();
    built = undefined;
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── production assembly surface ─────────────────────────────────────────

// Shared seam: injected into every buildHarnessEngine call site, cutting off
// the repo-root .mcp.json's iknow-trace server (schema compile + tsx
// child-process noise + 30s firstTurnReady window) and the real SDK
// countTokens network call.
//
// Stubbing `countTokens` with a fixed small value (rather than
// skipCountTokens) is deliberate: this file verifies the subagentsDir /
// NoopTrace / query_trace wiring, and which overflow branch is taken is
// irrelevant to the assertions — the fixed value pins the decision to the
// deterministic "below threshold" branch instead of relying on the failure
// path of a live call to a dead port during assembly. Dedicated tests for
// the overflow and index-demotion paths:
// build-engine-tool-overflow.test.ts and disclosure-index-align/.
const traceSeam = {
  createMcpManager: (opts: Parameters<typeof createMcpManager>[0]) =>
    createMcpManager({
      ...opts,
      config: opts.config.filter((s) => s.name !== "iknow-trace"),
    }),
  createMcpClient: fakeMcpClient,
  countTokens: async () => ({ inputTokens: 100 }),
} as const;

describe("buildHarnessEngine — subagentsDir 注入缝 (T5 SC8 + L2)", () => {
  it("opts.subagentsDir → 内置 createSubAgentManager 收到该 subagentsDir, spawn def → per-agent JSONL 含三类事件", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-trace-1"),
      askUser: createNoAskUser(),
      subagentsDir: scratchDir,
      ...traceSeam,
    });

    // 1. manager present + createSubAgentManager called, receiving exactly
    //    the subagentsDir we injected (proves buildHarnessEngine's
    //    opts.subagentsDir is threaded to createSubAgentManager({subagentsDir})).
    expect(built.subagentManager).toBeDefined();
    expect(mockState.captureCallCount).toBe(1);
    expect(mockState.capturedSubagentsDir).toBe(scratchDir);

    // 2. spawn def → per-agent JSONL containing the three event types
    //    subagent_spawn / _state_change / _stop (mirrors
    //    manager-trace.test.ts:339, but lands at
    //    `<subagentsDir>/agent-<taskId>.jsonl` instead of `subagent.jsonl`).
    const manager = built.subagentManager!;
    const { taskId } = manager.spawn({ task: "do thing" });
    expect(mockState.fakeChildren.length).toBe(1);
    emitEnvelope(mockState.fakeChildren[0]!, okEnvelope("r"));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const filePath = join(scratchDir, taskId, `agent-${taskId}.jsonl`);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const recordTypes = lines.map((l) => JSON.parse(l).record_type as string);
    const subagentLines = recordTypes.filter((t) => t.startsWith("subagent_"));
    assert.ok(
      subagentLines.length >= 3,
      `expected >=3 subagent_* lines, got ${subagentLines.length} (${recordTypes.join(",")})`
    );
    expect(recordTypes).toContain("subagent_spawn");
    expect(recordTypes).toContain("subagent_state_change");
    expect(recordTypes).toContain("subagent_stop");
  });

  it("缺省 subagentsDir → createSubAgentManager 收到的 trace 是 NoopTraceService", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-noop-1"),
      askUser: createNoAskUser(),
      ...traceSeam,
    });
    expect(built.subagentManager).toBeDefined();
    expect(mockState.captureCallCount).toBe(1);
    // subagentsDir absent + opts.trace retired → manager uses NoopTrace and
    // writes nothing to disk (byte-stable default behavior, equivalent to
    // the old default subagentTrace shape).
    expect(mockState.capturedSubagentsDir).toBeUndefined();
    expect(mockState.capturedTraceOpt).toBeUndefined();
  });

  it("subagentDiagnosticsDir → manager receives the crash diagnostics root", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-diagnostics-1"),
      askUser: createNoAskUser(),
      subagentDiagnosticsDir: scratchDir,
      ...traceSeam,
    });

    expect(mockState.capturedDiagnosticsDir).toBe(scratchDir);
  });

  it("subagentDiagnosticsDir → query_trace reads that tree, not workspaceRoot/trace", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "iknow-query-trace-dir-"));
    // A session lands in a two-level tree: `<baseDir>/projects/<slug>/<convId>/trace.jsonl`.
    const convDir = join(
      customDir,
      "projects",
      "test-project-subagent-trace",
      "c-custom"
    );
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, "trace.jsonl"),
      `${JSON.stringify({
        conversation_id: "c-custom",
        record_type: "turn",
        turn_id: "turn-custom",
        started_at: "2026-08-28T00:00:01.000Z",
        status: "ok",
      })}\n`
    );
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-query-trace-dir-1"),
      askUser: createNoAskUser(),
      subagentDiagnosticsDir: customDir,
      ...traceSeam,
    });
    const tool = built.deps.registry
      .list()
      .find((entry) => entry.name === "query_trace");
    expect(tool).toBeDefined();
    const raw = (await tool!.handler({
      conversation_id: "c-custom",
    })) as string;
    const body = JSON.parse(raw) as { records: Array<{ turn_id?: string }> };
    expect(body.records.some((row) => row.turn_id === "turn-custom")).toBe(
      true
    );
    rmSync(customDir, { recursive: true, force: true });
  });
});
