/**
 * `TurnRecord.id`: a caller-pregenerated id slot so parentTurnId is real.
 *
 * Context: `parent_turn_id` must join back to the turn row via
 * `?parent_turn_id=`, which requires the writer to know the turn id **before
 * emitting subagent records**. The old implementation randomUUID'd inside
 * `recordTurn` — by then the tool phase was long over and subagents could
 * never see the value.
 *
 * Contracts locked here:
 * 1. Caller supplies `id` → the persisted `turn_id` equals it verbatim, and no extra `id` key is written;
 * 2. Caller omits `id` → the implementation still generates a UUID (existing behavior, backward compatible).
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import type { TurnRecord } from "../../../src/harness/trace/types.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_TURN: TurnRecord = {
  turnIndex: 3,
  startedAt: "2026-08-26T00:00:00.000Z",
  endedAt: "2026-08-26T00:00:01.000Z",
  durationMs: 1000,
  llmCallIds: ["llm-1"],
  toolCallIds: ["tool-1"],
  decision: "completed",
  status: "ok",
};

function captureWriter(): { lines: string[]; writer: (line: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (line: string): void => void lines.push(line) };
}

describe("recordTurn — 调用方预生成 turn id (F-4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "iknow-turn-id-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("record.id 在场 → turn_id 逐字等于它, 且不落多余 id 键", async () => {
    const cap = captureWriter();
    const svc = createJsonlTraceService({
      filePath: dir,
      conversationId: "c-turn-id",
      writer: cap.writer,
    });

    const returned = await svc.recordTurn({ ...BASE_TURN, id: "turn-abc-123" });

    assert.equal(returned, "turn-abc-123");
    assert.equal(cap.lines.length, 1);
    const row = JSON.parse(cap.lines[0]!) as Record<string, unknown>;
    assert.equal(row["record_type"], "turn");
    assert.equal(row["turn_id"], "turn-abc-123");
    assert.ok(!("id" in row), "id 键不重复落盘 (与 verification/goal 同形态)");
  });

  it("record.id 缺席 → 实现仍生成 UUID (既有行为)", async () => {
    const cap = captureWriter();
    const svc = createJsonlTraceService({
      filePath: dir,
      conversationId: "c-turn-id",
      writer: cap.writer,
    });

    const returned = await svc.recordTurn(BASE_TURN);

    assert.ok(returned !== undefined);
    assert.match(returned, UUID_RE);
    const row = JSON.parse(cap.lines[0]!) as Record<string, unknown>;
    assert.equal(row["turn_id"], returned);
  });
});
