/**
 * D-α V1 graph mode T1 — `SUBAGENT_STEP` record_type（观测地板第 4 件）。
 *
 * 与 spawn / stop / state_change 三类同形态（id 由调用方提供、Postel 可选
 * 字段、@throws never），唯一形态差异是 id 载体为 `subagent_step_id`：前三类
 * 的 `id === taskId`（同一子代理实例），step 的 id 每步唯一。
 *
 * 覆盖：
 *   1. jsonl 行形状（record_type / subagent_step_id / snake_case 顶层 key）；
 *   2. Postel 可选字段缺席 → 不写 key；
 *   3. always-throw writer → 返回 undefined 不抛；
 *   4. noop 实现返回 undefined；
 *   5. traceserver 读侧认得 `subagent_step` 且有 step 专属列。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type { SubagentStepRecord } from "../../../src/harness/trace/types.ts";
import { TRACE_RECORD_TYPES } from "../../../src/traceserver/types.ts";
import { TRACE_FIELD_DEFS } from "../../../src/traceserver/fields.ts";

const SAMPLE_DISPATCH: SubagentStepRecord = {
  id: "step-1",
  taskId: "task-1",
  origin: "parent",
  stepIndex: 0,
  phase: "dispatch",
  label: "analyze",
  startedAt: "2026-08-27T00:00:00.000Z",
  status: "ok",
  ts: "2026-08-27T00:00:00.000Z",
};

const SAMPLE_SETTLE: SubagentStepRecord = {
  id: "step-2",
  taskId: "task-1",
  parentTurnId: "turn-1",
  origin: "parent",
  stepIndex: 0,
  phase: "settle",
  label: "analyze",
  startedAt: "2026-08-27T00:00:00.000Z",
  endedAt: "2026-08-27T00:00:02.000Z",
  durationMs: 2000,
  status: "ok",
  ts: "2026-08-27T00:00:02.000Z",
};

function readLines(dir: string, conversationId: string): unknown[] {
  const raw = readFileSync(join(dir, `${conversationId}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("trace: recordSubagentStep (jsonl sink)", () => {
  it("dispatch 行: record_type=subagent_step, id 载体是 subagent_step_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-step-"));
    try {
      const svc = createJsonlTraceService({
        filePath: dir,
        conversationId: "conv-step",
      });
      const returned = await svc.recordSubagentStep(SAMPLE_DISPATCH);
      assert.equal(returned, "step-1");
      const [line] = readLines(dir, "conv-step") as Array<
        Record<string, unknown>
      >;
      assert.equal(line!.record_type, "subagent_step");
      assert.equal(line!.subagent_step_id, "step-1");
      assert.equal(line!.conversation_id, "conv-step");
      assert.equal(line!.task_id, "task-1");
      assert.equal(line!.step_index, 0);
      assert.equal(line!.phase, "dispatch");
      assert.equal(line!.label, "analyze");
      assert.equal(line!.started_at, "2026-08-27T00:00:00.000Z");
      // step 的 id 不占 subagent_id 列（那是子代理实例 id 的语义）
      assert.equal("subagent_id" in line!, false);
      // Postel: 缺席可选字段不落 key
      assert.equal("parent_turn_id" in line!, false);
      assert.equal("ended_at" in line!, false);
      assert.equal("duration_ms" in line!, false);
      assert.equal("id" in line!, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settle 行补 ended_at / duration_ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-step-"));
    try {
      const svc = createJsonlTraceService({
        filePath: dir,
        conversationId: "conv-settle",
      });
      await svc.recordSubagentStep(SAMPLE_SETTLE);
      const [line] = readLines(dir, "conv-settle") as Array<
        Record<string, unknown>
      >;
      assert.equal(line!.phase, "settle");
      assert.equal(line!.ended_at, "2026-08-27T00:00:02.000Z");
      assert.equal(line!.duration_ms, 2000);
      assert.equal(line!.parent_turn_id, "turn-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("always-throw writer → 返回 undefined, 不抛 (@throws never)", async () => {
    const svc = createJsonlTraceService({
      filePath: join(tmpdir(), "iknow-step-never"),
      conversationId: "conv-throw",
      writer: () => {
        throw new Error("disk full");
      },
    });
    assert.equal(await svc.recordSubagentStep(SAMPLE_DISPATCH), undefined);
  });

  it("noop 实现返回 undefined（零副作用）", async () => {
    const svc = createNoopTraceService();
    assert.equal(await svc.recordSubagentStep(SAMPLE_DISPATCH), undefined);
  });
});

describe("traceserver: subagent_step 读侧", () => {
  it("TRACE_RECORD_TYPES 含 subagent_step（append-only 末位）", () => {
    assert.ok(TRACE_RECORD_TYPES.includes("subagent_step"));
  });

  it("有 step 专属列: subagent_step_id / step_index / phase", () => {
    const keys = TRACE_FIELD_DEFS.filter((d) =>
      d.recordTypes.includes("subagent_step")
    ).map((d) => d.key);
    for (const expected of ["subagentStepId", "stepIndex", "phase", "taskId"]) {
      assert.ok(keys.includes(expected), `missing field ${expected}`);
    }
    // subagentId 列刻意不挂 step（id 载体不同）
    const subagentIdDef = TRACE_FIELD_DEFS.find((d) => d.key === "subagentId");
    assert.ok(subagentIdDef);
    assert.equal(subagentIdDef!.recordTypes.includes("subagent_step"), false);
  });
});
