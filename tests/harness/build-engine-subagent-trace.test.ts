/**
 * T5 (plans/session-folder-consolidation.md / SC8 + L2):
 * build-engine 的 subagentsDir 注入缝 —— SC1 生产装配面
 * (cli.ts chat path + hub.ts ensureDeps)。
 *
 * 契约（plans/358 §SC1 + spec AC,迁到 T5 后语义）：
 *   1. buildHarnessEngine({ subagentsDir }) → 内置 createSubAgentManager
 *      收到该 subagentsDir；通过 fake spawn 工厂触发 spawn 后, 真实 JSONL
 *      落在 `<subagentsDir>/agent-<taskId>.jsonl` 含三类事件。
 *   2. 缺省 subagentsDir → manager 走 NoopTraceService（byte-stable,等价
 *      旧 subagentTrace 缺省形态）。
 *
 * 与 tests/subagent/manager-trace.test.ts 的差异：后者直接构造 manager,
 * 注入 trace + fake spawn 工厂；本文件验证 build-engine 的 subagentsDir
 * 装配链 —— opts.subagentsDir 正确传入 manager。
 *
 * Mock 策略：vi.mock 整模块（同步 fake — `vi.hoisted` 共享 state），
 * 让 build-engine.ts 的 `import { createSubAgentManager }` 解析到 spy，
 * spy 把 spawn 工厂替换为 fake（不启真实 worker）。ESM live binding 特性
 * 下 vi.spyOn(module, "createSubAgentManager") 只改 namespace 不改
 * import binding（详见 tests/harness/aci/registry-workspace-root.test.ts
 * 注释）；模块级 vi.mock 才是正确的拦截方式。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { McpClientHandle } from "../../src/harness/mcp/manager.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";

// 隔离仓库根 .mcp.json 的 iknow-trace server(schema compile validator 在
// 单测环境不可达，触发的 30s 装配期窗口与 tsx 子进程噪声都是同一条依赖面的
// 副作用) —— 走 build-engine 已留的 createMcpManager / createMcpClient 测试缝。
// 同时 stub 真实 SDK countTokens 网络调用(127.0.0.1:9999 死端口)。其它 MCP
// 形态不动。stub scope 与不变式仍真实：trace 注入 / NoopTrace 默认 /
// diagnosticsDir 透传 / query_trace 走 diagnosticsDir 树。
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

// Module mock 必须先于 buildHarnessEngine 的 dynamic import。vi.hoisted
// 共享 state 解决 vi.mock 工厂被 hoisted 与 fakeChildren 变量声明顺序问题。
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

// ── SC1 生产装配面 ──────────────────────────────────────────────────────

// 共享 seam：每个 buildHarnessEngine 调用点都注入这一组，截断仓库根
// .mcp.json 的 iknow-trace server（schema compile + tsx 子进程噪声 +
// 30s firstTurnReady 窗口）以及真实 SDK countTokens 网络调用。
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

    // 1. manager 在场 + createSubAgentManager 被调用, 收到的 subagentsDir opt ===
    //    我们注入的（验证 buildHarnessEngine opts.subagentsDir 透传到
    //    createSubAgentManager({subagentsDir})）。
    expect(built.subagentManager).toBeDefined();
    expect(mockState.captureCallCount).toBe(1);
    expect(mockState.capturedSubagentsDir).toBe(scratchDir);

    // 2. spawn def → per-agent JSONL 含 subagent_spawn / _state_change /
    //    _stop 三类事件（mirror manager-trace.test.ts:339,但落点在
    //    `<subagentsDir>/agent-<taskId>.jsonl` 而不是 `subagent.jsonl`）。
    const manager = built.subagentManager!;
    const { taskId } = manager.spawn({ task: "do thing" });
    expect(mockState.fakeChildren.length).toBe(1);
    emitEnvelope(mockState.fakeChildren[0]!, okEnvelope("r"));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const filePath = join(scratchDir, `agent-${taskId}.jsonl`);
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
    // T5: subagentsDir 缺省 + opts.trace 已退役 → manager 走 NoopTrace,
    // 不写盘(验证 byte-stable 默认行为, 等价旧 subagentTrace 缺省形态)。
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
    writeFileSync(
      join(customDir, "c-custom.jsonl"),
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
