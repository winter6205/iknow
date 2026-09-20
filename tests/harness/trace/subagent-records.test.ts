/**
 * SubagentSpawnRecord / SubagentStopRecord / SubagentStateChangeRecord
 * + recordSubagentSpawn / recordSubagentStop / recordSubagentStateChange
 * (subagent runtime observation).
 *
 * Contracts (mirrors verification.test.ts / goal-trace.test.ts wiring:
 * captureWriter + always-throw writer):
 * 1. jsonl sink writes all three record kinds: row shape (record_type literal /
 *    subagent_id carries the caller-supplied id / snake_case top-level keys /
 *    conversation_id instance-bound / no duplicate id carrier / ISO ts)
 * 2. absent optional fields (model/taskPreview/maxTurns/timeoutMs/error/
 *    exitCode/signal/reason/summary) → key omitted (Postel)
 * 3. always-throw writer → returns undefined, never throws (@throws never)
 * 4. noop implementation returns undefined (zero side effects)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type {
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
} from "../../../src/harness/trace/types.ts";

// ─── minimal samples with caller-provided ids (aligned with manager taskId) ──

const SAMPLE_SPAWN: SubagentSpawnRecord = {
  id: "task-spawn-1",
  taskId: "task-spawn-1",
  parentTurnId: "turn-1",
  origin: "parent",
  startedAt: "2026-08-18T00:00:00.000Z",
  status: "ok",
  ts: "2026-08-18T00:00:00.000Z",
  // Postel optional: model / taskPreview / maxTurns / timeoutMs — absent ⇒ key not written
  model: "opus",
  taskPreview: "实现 goal 生命周期",
  maxTurns: 5,
  timeoutMs: 7200000,
};

const SAMPLE_STOP: SubagentStopRecord = {
  id: "task-spawn-1",
  taskId: "task-spawn-1",
  parentTurnId: "turn-1",
  origin: "parent",
  startedAt: "2026-08-18T00:00:00.000Z",
  endedAt: "2026-08-18T00:00:05.000Z",
  durationMs: 5000,
  finalState: "completed",
  status: "ok",
  ts: "2026-08-18T00:00:05.000Z",
  // Postel optional: exitCode / signal / reason / summary
  exitCode: 0,
  summary: "ok result",
};

const SAMPLE_STATE_CHANGE: SubagentStateChangeRecord = {
  id: "task-spawn-1",
  taskId: "task-spawn-1",
  parentTurnId: "turn-1",
  origin: "parent",
  startedAt: "2026-08-18T00:00:00.000Z",
  status: "ok",
  ts: "2026-08-18T00:00:01.000Z",
  fromState: "starting",
  toState: "running",
};

function captureWriter(): {
  lines: string[];
  writer: (line: string) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    writer: (line: string): void => {
      lines.push(line);
    },
  };
}

// ─── recordSubagentSpawn ────────────────────────────────────────────────────

describe("createJsonlTraceService — recordSubagentSpawn (T4, #358)", () => {
  it("行形状: record_type=subagent_spawn, subagent_id 取调用方 id, 顶层 snake_case, conversation_id 存在, 无重复 id 载体", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-spawn.jsonl",
      conversationId: "conv-subagent-spawn",
      writer,
    });
    const returned = await svc.recordSubagentSpawn(SAMPLE_SPAWN);
    assert.equal(returned, SAMPLE_SPAWN.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.record_type, "subagent_spawn");
    assert.equal(parsed.subagent_id, "task-spawn-1");
    assert.equal(parsed.conversation_id, "conv-subagent-spawn");
    // snake_case top-level keys
    assert.equal(parsed.task_id, "task-spawn-1");
    assert.equal(parsed.parent_turn_id, "turn-1");
    assert.equal(parsed.origin, "parent");
    assert.equal(parsed.started_at, "2026-08-18T00:00:00.000Z");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.model, "opus");
    assert.equal(parsed.task_preview, "实现 goal 生命周期");
    assert.equal(parsed.max_turns, 5);
    assert.equal(parsed.timeout_ms, 7200000);
    assert.equal(parsed.ts, SAMPLE_SPAWN.ts);
    // Single id carrier: no duplicate top-level id (subagent_id already carries it)
    assert.equal(parsed.id, undefined);
  });

  it("Postel: 可选字段缺席 (model / taskPreview / maxTurns / timeoutMs) → 不写对应 key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-spawn-min.jsonl",
      conversationId: "conv-subagent-spawn-min",
      writer,
    });
    const minimal: SubagentSpawnRecord = {
      id: "task-spawn-2",
      taskId: "task-spawn-2",
      parentTurnId: "turn-2",
      origin: "parent",
      startedAt: "2026-08-18T00:00:02.000Z",
      status: "ok",
      ts: "2026-08-18T00:00:02.000Z",
    };
    await svc.recordSubagentSpawn(minimal);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(!("model" in parsed), "model must be absent");
    assert.ok(!("task_preview" in parsed), "task_preview must be absent");
    assert.ok(!("max_turns" in parsed), "max_turns must be absent");
    assert.ok(!("timeout_ms" in parsed), "timeout_ms must be absent");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-spawn-fail.jsonl",
      conversationId: "conv-subagent-spawn-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordSubagentSpawn(SAMPLE_SPAWN);
    assert.equal(result, undefined);
  });
});

// ─── recordSubagentStop ─────────────────────────────────────────────────────

describe("createJsonlTraceService — recordSubagentStop (T4, #358)", () => {
  it("行形状: record_type=subagent_stop, subagent_id 取调用方 id, endedAt/durationMs/finalState 落盘", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-stop.jsonl",
      conversationId: "conv-subagent-stop",
      writer,
    });
    const returned = await svc.recordSubagentStop(SAMPLE_STOP);
    assert.equal(returned, SAMPLE_STOP.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.record_type, "subagent_stop");
    assert.equal(parsed.subagent_id, "task-spawn-1");
    assert.equal(parsed.conversation_id, "conv-subagent-stop");
    // snake_case top-level keys
    assert.equal(parsed.task_id, "task-spawn-1");
    assert.equal(parsed.parent_turn_id, "turn-1");
    assert.equal(parsed.origin, "parent");
    assert.equal(parsed.started_at, "2026-08-18T00:00:00.000Z");
    assert.equal(parsed.ended_at, "2026-08-18T00:00:05.000Z");
    assert.equal(parsed.duration_ms, 5000);
    assert.equal(parsed.final_state, "completed");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.exit_code, 0);
    assert.equal(parsed.summary, "ok result");
    assert.equal(parsed.ts, SAMPLE_STOP.ts);
    // Single id carrier: no duplicate top-level id (subagent_id already carries it)
    assert.equal(parsed.id, undefined);
  });

  it("Postel: failed scenario with reason + signal → 全部落 key;可用 reason 域含 'cancelled'", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-stop-fail.jsonl",
      conversationId: "conv-subagent-stop-fail",
      writer,
    });
    const failed: SubagentStopRecord = {
      id: "task-stop-1",
      taskId: "task-stop-1",
      parentTurnId: "turn-3",
      origin: "parent",
      startedAt: "2026-08-18T00:00:00.000Z",
      endedAt: "2026-08-18T00:00:10.000Z",
      durationMs: 10000,
      finalState: "failed",
      status: "error",
      ts: "2026-08-18T00:00:10.000Z",
      signal: "SIGTERM",
      reason: "timeout",
      summary: "timeout after 10000ms",
    };
    await svc.recordSubagentStop(failed);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.final_state, "failed");
    assert.equal(parsed.status, "error");
    assert.equal(parsed.signal, "SIGTERM");
    assert.equal(parsed.reason, "timeout");
    assert.equal(parsed.summary, "timeout after 10000ms");
  });

  it("Postel: 可选字段缺席 (exitCode / signal / reason / summary) → 不写对应 key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-stop-min.jsonl",
      conversationId: "conv-subagent-stop-min",
      writer,
    });
    const minimal: SubagentStopRecord = {
      id: "task-stop-min",
      taskId: "task-stop-min",
      parentTurnId: "turn-4",
      origin: "parent",
      startedAt: "2026-08-18T00:00:03.000Z",
      endedAt: "2026-08-18T00:00:04.000Z",
      durationMs: 1000,
      finalState: "completed",
      status: "ok",
      ts: "2026-08-18T00:00:04.000Z",
    };
    await svc.recordSubagentStop(minimal);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(!("exit_code" in parsed), "exit_code must be absent");
    assert.ok(!("signal" in parsed), "signal must be absent");
    assert.ok(!("reason" in parsed), "reason must be absent");
    assert.ok(!("summary" in parsed), "summary must be absent");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-stop-fail.jsonl",
      conversationId: "conv-subagent-stop-fail2",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordSubagentStop(SAMPLE_STOP);
    assert.equal(result, undefined);
  });
});

// ─── recordSubagentStateChange ──────────────────────────────────────────────

describe("createJsonlTraceService — recordSubagentStateChange (T4, #358)", () => {
  it("行形状: record_type=subagent_state_change, subagent_id 取调用方 id, fromState/toState 落盘", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-sc.jsonl",
      conversationId: "conv-subagent-sc",
      writer,
    });
    const returned = await svc.recordSubagentStateChange(SAMPLE_STATE_CHANGE);
    assert.equal(returned, SAMPLE_STATE_CHANGE.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.record_type, "subagent_state_change");
    assert.equal(parsed.subagent_id, "task-spawn-1");
    assert.equal(parsed.conversation_id, "conv-subagent-sc");
    // snake_case top-level keys
    assert.equal(parsed.from_state, "starting");
    assert.equal(parsed.to_state, "running");
    assert.equal(parsed.parent_turn_id, "turn-1");
    assert.equal(parsed.origin, "parent");
    assert.equal(parsed.ts, SAMPLE_STATE_CHANGE.ts);
    assert.equal(parsed.id, undefined);
  });

  it("Postel: failed transition 携带 reason → 落 key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-sc-fail.jsonl",
      conversationId: "conv-subagent-sc-fail",
      writer,
    });
    const failedTransition: SubagentStateChangeRecord = {
      id: "task-sc-1",
      taskId: "task-sc-1",
      parentTurnId: "turn-5",
      origin: "parent",
      startedAt: "2026-08-18T00:00:05.000Z",
      status: "error",
      ts: "2026-08-18T00:00:10.000Z",
      fromState: "running",
      toState: "failed",
      reason: "timeout",
    };
    await svc.recordSubagentStateChange(failedTransition);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.from_state, "running");
    assert.equal(parsed.to_state, "failed");
    assert.equal(parsed.reason, "timeout");
  });

  it("Postel: success transition 不带 reason → 不写 key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-sc-nofail.jsonl",
      conversationId: "conv-subagent-sc-nofail",
      writer,
    });
    const successTransition: SubagentStateChangeRecord = {
      id: "task-sc-2",
      taskId: "task-sc-2",
      parentTurnId: "turn-6",
      origin: "parent",
      startedAt: "2026-08-18T00:00:06.000Z",
      status: "ok",
      ts: "2026-08-18T00:00:07.000Z",
      fromState: "running",
      toState: "completed",
    };
    await svc.recordSubagentStateChange(successTransition);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(!("reason" in parsed), "reason must be absent for success");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-subagent-sc-fail2.jsonl",
      conversationId: "conv-subagent-sc-fail2",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordSubagentStateChange(SAMPLE_STATE_CHANGE);
    assert.equal(result, undefined);
  });
});

// ─── real-FS persistence verification ──────────────────────────────────────

describe("createJsonlTraceService — subagent records FS round-trip", () => {
  it("三类 record 落同一 conversationId 文件且行形状正确", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "iknow-trace-subagent-"));
    try {
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-subagent-rt",
      });
      const r1 = await svc.recordSubagentSpawn(SAMPLE_SPAWN);
      const r2 = await svc.recordSubagentStateChange(SAMPLE_STATE_CHANGE);
      const r3 = await svc.recordSubagentStop(SAMPLE_STOP);
      assert.equal(r1, "task-spawn-1");
      assert.equal(r2, "task-spawn-1");
      assert.equal(r3, "task-spawn-1");
      const filePath = join(scratch, "conv-subagent-rt.jsonl");
      assert.equal(existsSync(filePath), true);
      const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 3);
      const parsed0 = JSON.parse(lines[0]!) as Record<string, unknown>;
      const parsed1 = JSON.parse(lines[1]!) as Record<string, unknown>;
      const parsed2 = JSON.parse(lines[2]!) as Record<string, unknown>;
      assert.equal(parsed0["record_type"], "subagent_spawn");
      assert.equal(parsed1["record_type"], "subagent_state_change");
      assert.equal(parsed2["record_type"], "subagent_stop");
      // subagent_id is consistent across records (the reader uses it to pair spawn/stop)
      assert.equal(parsed0["subagent_id"], "task-spawn-1");
      assert.equal(parsed1["subagent_id"], "task-spawn-1");
      assert.equal(parsed2["subagent_id"], "task-spawn-1");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ─── noop path ─────────────────────────────────────────────────────────────

describe("createNoopTraceService — subagent records (T4, #358)", () => {
  it("recordSubagentSpawn 返回 undefined (零副作用)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentSpawn(SAMPLE_SPAWN);
    assert.equal(result, undefined);
  });

  it("recordSubagentStop 返回 undefined (零副作用)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentStop(SAMPLE_STOP);
    assert.equal(result, undefined);
  });

  it("recordSubagentStateChange 返回 undefined (零副作用)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordSubagentStateChange(SAMPLE_STATE_CHANGE);
    assert.equal(result, undefined);
  });
});
