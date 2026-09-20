/**
 * GoalRecord / recordGoal (goal lifecycle data contract).
 *
 * Contracts (mirrors verification.test.ts wiring: captureWriter + always-throw writer):
 * 1. jsonl sink writes GoalRecord rows: row shape (record_type="goal" / goal_id
 *    carries the caller-supplied id / snake_case top-level keys / conversation_id
 *    instance-bound / no duplicate id carrier)
 * 2. absent optional fields (status / text / textLen) → key omitted (Postel)
 * 3. full record (with status/text/textLen) round-trip: values kept, snake_case keys
 * 4. always-throw writer → returns undefined, never throws (@throws never)
 * 5. noop implementation returns undefined (zero side effects)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type { GoalRecord } from "../../../src/harness/trace/types.ts";

const SAMPLE_GOAL: GoalRecord = {
  // id / sessionId / ts are caller-provided (settled contract fields).
  id: "goal-1",
  sessionId: "sess-goal-1",
  action: "pin",
  status: "active",
  text: "实现 goal 生命周期",
  textLen: 9,
  ts: "2026-08-16T00:00:00.000Z",
  conversationId: "conv-goal-1",
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

describe("createJsonlTraceService — recordGoal", () => {
  it("行形状: record_type=goal, goal_id 取调用方 id, 顶层 snake_case, conversation_id 存在, 无重复 id 载体", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-goal.jsonl",
      conversationId: "conv-goal",
      writer,
    });
    const returned = await svc.recordGoal(SAMPLE_GOAL);
    assert.equal(returned, SAMPLE_GOAL.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.record_type, "goal");
    assert.equal(parsed.goal_id, "goal-1");
    assert.equal(parsed.conversation_id, "conv-goal");
    // snake_case top-level keys
    assert.equal(parsed.session_id, "sess-goal-1");
    assert.equal(parsed.action, "pin");
    assert.equal(parsed.status, "active");
    assert.equal(parsed.text, "实现 goal 生命周期");
    assert.equal(parsed.text_len, 9);
    assert.equal(parsed.ts, SAMPLE_GOAL.ts);
    // conversationId → conversation_id (top-level snake_case covers this field too)
    assert.equal(parsed.conversationId, undefined);
    // Single id carrier: no duplicate top-level id (goal_id already carries it)
    assert.equal(parsed.id, undefined);
  });

  it("可选字段缺席 (status / text / textLen) → 不写对应 key (Postel)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-goal.jsonl",
      conversationId: "conv-goal-min",
      writer,
    });
    const minimal: GoalRecord = {
      id: "goal-2",
      sessionId: "sess-goal-2",
      action: "clear",
      ts: "2026-08-16T00:00:01.000Z",
      conversationId: "conv-goal-2",
    };
    await svc.recordGoal(minimal);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(!("status" in parsed), "status must be absent");
    assert.ok(!("text" in parsed), "text must be absent");
    assert.ok(!("text_len" in parsed), "text_len must be absent");
  });

  it("完整 record (含 status/text/textLen) round-trip: 值保留 + snake_case key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-goal.jsonl",
      conversationId: "conv-goal-full",
      writer,
    });
    const returned = await svc.recordGoal(SAMPLE_GOAL);
    assert.equal(returned, SAMPLE_GOAL.id);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.status, "active");
    assert.equal(parsed.text, "实现 goal 生命周期");
    assert.equal(parsed.text_len, 9);
    assert.equal(parsed.action, "pin");
    assert.equal(parsed.goal_id, "goal-1");
    assert.equal(parsed.record_type, "goal");
  });

  it("textLen=0 是合法值 → 写 key (Postel: 0 不是缺席)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-goal.jsonl",
      conversationId: "conv-goal-zero",
      writer,
    });
    const zeroLen: GoalRecord = {
      id: "goal-3",
      sessionId: "sess-goal-3",
      action: "seed",
      textLen: 0,
      ts: "2026-08-16T00:00:02.000Z",
      conversationId: "conv-goal-3",
    };
    await svc.recordGoal(zeroLen);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.text_len, 0, "text_len 0 必须落 key");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-goal.jsonl",
      conversationId: "conv-goal-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordGoal(SAMPLE_GOAL);
    assert.equal(result, undefined);
  });

  it("真实 FS: 写 <dir>/<convId>.jsonl → re-read → 行形状 + 字段保留", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "iknow-trace-goal-"));
    try {
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-goal-fs",
      });
      const returned = await svc.recordGoal(SAMPLE_GOAL);
      assert.equal(returned, SAMPLE_GOAL.id);
      const filePath = join(scratch, "conv-goal-fs.jsonl");
      assert.equal(existsSync(filePath), true);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(parsed["record_type"], "goal");
      assert.equal(parsed["goal_id"], "goal-1");
      assert.equal(parsed["conversation_id"], "conv-goal-fs");
      assert.equal(parsed["action"], "pin");
      assert.equal(parsed["status"], "active");
      assert.equal(parsed["text"], "实现 goal 生命周期");
      assert.equal(parsed["text_len"], 9);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("createNoopTraceService — recordGoal", () => {
  it("返回 undefined (零副作用)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordGoal(SAMPLE_GOAL);
    assert.equal(result, undefined);
  });
});
