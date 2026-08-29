/**
 * createNoopTraceService (T2, GH #64)。
 *
 * 验证 7 项契约:
 * 1. 返回 TraceService, 仅 3 个公开方法
 * 2. recordLlmCall → resolves undefined
 * 3. recordToolCall → resolves undefined
 * 4. recordTurn → resolves undefined
 * 5. 零副作用 (scratch dir + console spy)
 * 6. undefined parentLlmCallId 也不抛
 * 7. 工厂重复调用 → 实例彼此独立
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  SessionRecord,
  SandboxCmdRecord,
} from "../../../src/harness/trace/types.ts";

const SAMPLE_LLM: LlmCallRecord = {
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  supplierStop: "success",
  stream: false,
  messagesCaptured: false,
  status: "ok",
};

const SAMPLE_TOOL: ToolCallRecord = {
  parentLlmCallId: "llm-1",
  toolName: "echo",
  toolKind: "ok",
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:00.500Z",
  durationMs: 500,
  argumentsCaptured: false,
  resultCaptured: false,
  status: "ok",
};

const SAMPLE_TURN: TurnRecord = {
  turnIndex: 0,
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:01.000Z",
  durationMs: 1000,
  llmCallIds: ["llm-1"],
  toolCallIds: ["tool-1"],
  decision: "completed",
  status: "ok",
};

const SAMPLE_SESSION: SessionRecord = {
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:01:00.000Z",
  durationMs: 60000,
  agentVersion: "0.20.0",
  status: "ok",
};

const SAMPLE_CMD: SandboxCmdRecord = {
  parentTurnId: "turn-1",
  command: "ls -la",
  exitCode: 0,
  stdoutCaptured: true,
  startedAt: "2026-07-31T00:00:00.000Z",
  endedAt: "2026-07-31T00:00:00.100Z",
  durationMs: 100,
  status: "ok",
};

describe("createNoopTraceService", () => {
  const consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
  ];
  afterEach(() => {
    for (const spy of consoleSpies) spy.mockClear();
  });

  it("returns a TraceService with exactly 11 public methods", () => {
    const svc = createNoopTraceService();
    expect(typeof svc.recordLlmCall).toBe("function");
    expect(typeof svc.recordToolCall).toBe("function");
    expect(typeof svc.recordTurn).toBe("function");
    expect(typeof svc.recordSession).toBe("function");
    expect(typeof svc.recordSandboxCmd).toBe("function");
    expect(typeof svc.recordVerification).toBe("function");
    expect(typeof svc.recordGoal).toBe("function");
    expect(typeof svc.recordSubagentSpawn).toBe("function");
    expect(typeof svc.recordSubagentStop).toBe("function");
    expect(typeof svc.recordSubagentStateChange).toBe("function");
    expect(typeof svc.recordSubagentStep).toBe("function");
    const ownKeys = Object.keys(svc).sort();
    assert.deepEqual(ownKeys, [
      "recordGoal",
      "recordLlmCall",
      "recordSandboxCmd",
      "recordSession",
      "recordSubagentSpawn",
      "recordSubagentStateChange",
      "recordSubagentStep",
      "recordSubagentStop",
      "recordToolCall",
      "recordTurn",
      "recordVerification",
    ]);
  });

  it("recordLlmCall resolves undefined", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordLlmCall(SAMPLE_LLM);
    assert.equal(result, undefined);
    assert.equal(svc.traceWriteFailures, 0);
  });

  it("recordToolCall resolves undefined", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordToolCall(SAMPLE_TOOL);
    assert.equal(result, undefined);
  });

  it("recordTurn resolves undefined", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordTurn(SAMPLE_TURN);
    assert.equal(result, undefined);
  });

  it("recordSubagentSpawn resolves undefined (T4 #358)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentSpawn({
      id: "task-1",
      taskId: "task-1",
      origin: "parent",
      startedAt: "2026-08-18T00:00:00.000Z",
      status: "ok",
      ts: "2026-08-18T00:00:00.000Z",
    });
    assert.equal(result, undefined);
  });

  it("recordSubagentStop resolves undefined (T4 #358)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentStop({
      id: "task-1",
      taskId: "task-1",
      origin: "parent",
      startedAt: "2026-08-18T00:00:00.000Z",
      endedAt: "2026-08-18T00:00:01.000Z",
      durationMs: 1000,
      finalState: "completed",
      status: "ok",
      ts: "2026-08-18T00:00:01.000Z",
    });
    assert.equal(result, undefined);
  });

  it("recordSubagentStateChange resolves undefined (T4 #358)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentStateChange({
      id: "task-1",
      taskId: "task-1",
      origin: "parent",
      startedAt: "2026-08-18T00:00:00.000Z",
      status: "ok",
      ts: "2026-08-18T00:00:00.500Z",
      fromState: "starting",
      toState: "running",
    });
    assert.equal(result, undefined);
  });

  it("has zero side effects (no console output, no FS writes)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "noop-trace-test-"));
    try {
      const before = new Set(readdirSync(scratch));
      const svc = createNoopTraceService();
      await svc.recordLlmCall(SAMPLE_LLM);
      await svc.recordToolCall(SAMPLE_TOOL);
      await svc.recordTurn(SAMPLE_TURN);
      await svc.recordSession(SAMPLE_SESSION);
      await svc.recordSandboxCmd(SAMPLE_CMD);
      const after = new Set(readdirSync(scratch));
      assert.deepEqual(
        [...after].sort(),
        [...before].sort(),
        "FS must be untouched"
      );
      for (const spy of consoleSpies) {
        assert.equal(
          spy.mock.calls.length,
          0,
          "console must not have been called"
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("accepts undefined parentLlmCallId on recordToolCall without throwing", async () => {
    const svc = createNoopTraceService();
    const orphan: ToolCallRecord = {
      ...SAMPLE_TOOL,
      parentLlmCallId: undefined,
    };
    const result = await svc.recordToolCall(orphan);
    assert.equal(result, undefined);
  });

  it("factory calls produce independent instances (not the same reference)", () => {
    const a = createNoopTraceService();
    const b = createNoopTraceService();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.recordLlmCall, b.recordLlmCall);
    assert.notStrictEqual(a.recordToolCall, b.recordToolCall);
    assert.notStrictEqual(a.recordTurn, b.recordTurn);
  });
});
