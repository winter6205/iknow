/**
 * #358 T5 — traceserver 读侧 subagent 三类记录
 * (subagent_spawn / subagent_stop / subagent_state_change)。
 *
 * 写侧 T4 已落地 (src/harness/trace/jsonl.ts): 顶层 key 经 camelToSnake,
 * `subagent_id` 是显式 id 载体 (id = manager taskId)。本文件验证读侧:
 *   1. TRACE_RECORD_TYPES 白名单含三类 + parseRecordType 接受 (HTTP 200)。
 *   2. ?task_id= / ?parent_turn_id= 精确过滤, 与既有过滤 AND 组合。
 *   3. 空 task_id / parent_turn_id → ValidationError (400, field)。
 *   4. TraceQuery 无新字段 → 行为不变 (向后兼容)。
 *   5. TRACE_FIELD_DEFS 新增 subagent 列 + recordTypes 作用域正确 + 唯一性自检。
 *   6. Reader 集成: 临时 JSONL + createJsonlTraceReader, taskId 过滤命中且时间降序。
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlTraceReader,
  TRACE_FIELD_DEFS,
  TRACE_RECORD_TYPES,
  type TraceFieldDef,
} from "../../src/traceserver/index.ts";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

// ─── fixture rows (snake_case wire shape, mirror jsonl.ts) ──────────────────

function spawnRow(o: {
  id: string;
  taskId: string;
  parentTurnId?: string;
  startedAt: string;
  status?: "ok" | "error";
}): string {
  return JSON.stringify({
    conversation_id: "c1",
    record_type: "subagent_spawn",
    subagent_id: o.id,
    task_id: o.taskId,
    ...(o.parentTurnId !== undefined ? { parent_turn_id: o.parentTurnId } : {}),
    origin: "parent",
    started_at: o.startedAt,
    status: o.status ?? "ok",
    ts: o.startedAt,
  });
}

function stateChangeRow(o: {
  id: string;
  taskId: string;
  parentTurnId?: string;
  startedAt: string;
  fromState: string;
  toState: string;
  status?: "ok" | "error";
}): string {
  return JSON.stringify({
    conversation_id: "c1",
    record_type: "subagent_state_change",
    subagent_id: o.id,
    task_id: o.taskId,
    ...(o.parentTurnId !== undefined ? { parent_turn_id: o.parentTurnId } : {}),
    origin: "parent",
    started_at: o.startedAt,
    from_state: o.fromState,
    to_state: o.toState,
    status: o.status ?? "ok",
    ts: o.startedAt,
  });
}

function stopRow(o: {
  id: string;
  taskId: string;
  parentTurnId?: string;
  startedAt: string;
  endedAt: string;
  finalState: "completed" | "failed";
  status?: "ok" | "error";
}): string {
  return JSON.stringify({
    conversation_id: "c1",
    record_type: "subagent_stop",
    subagent_id: o.id,
    task_id: o.taskId,
    ...(o.parentTurnId !== undefined ? { parent_turn_id: o.parentTurnId } : {}),
    origin: "parent",
    started_at: o.startedAt,
    ended_at: o.endedAt,
    duration_ms: 60000,
    final_state: o.finalState,
    status: o.status ?? "ok",
    ts: o.endedAt,
  });
}

function llmRow(startedAt: string): string {
  return JSON.stringify({
    conversation_id: "c1",
    record_type: "llm_call",
    llm_call_id: `l-${startedAt}`,
    started_at: startedAt,
    status: "ok",
  });
}

/** 文件写入顺序故意打乱 — 读侧必须按 started_at 降序还原。 */
const lines: readonly string[] = [
  llmRow("2026-08-01T00:00:00.000Z"),
  spawnRow({
    id: "sa-1",
    taskId: "t-1",
    parentTurnId: "p-1",
    startedAt: "2026-08-01T01:00:00.000Z",
  }),
  stateChangeRow({
    id: "sa-1",
    taskId: "t-1",
    parentTurnId: "p-1",
    startedAt: "2026-08-01T01:00:01.000Z",
    fromState: "starting",
    toState: "running",
  }),
  stopRow({
    id: "sa-1",
    taskId: "t-1",
    parentTurnId: "p-1",
    startedAt: "2026-08-01T01:00:00.000Z",
    endedAt: "2026-08-01T01:01:00.000Z",
    finalState: "completed",
  }),
  spawnRow({
    id: "sa-2",
    taskId: "t-2",
    parentTurnId: "p-2",
    startedAt: "2026-08-01T02:00:00.000Z",
    status: "error",
  }),
];

function asTraceBody(body: unknown): {
  records: Array<Record<string, unknown>>;
  total: number;
} {
  const b = body as Record<string, unknown>;
  return {
    records: Array.isArray(b["records"])
      ? (b["records"] as Array<Record<string, unknown>>)
      : [],
    total: typeof b["total"] === "number" ? b["total"] : -1,
  };
}

// ─── whitelist (・) ──────────────────────────────────────────────────────────

describe("TRACE_RECORD_TYPES — #358 T5 whitelist", () => {
  it("contains the three subagent record types", () => {
    const list = TRACE_RECORD_TYPES as readonly string[];
    for (const t of [
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
    ]) {
      assert.ok(list.includes(t), `TRACE_RECORD_TYPES must include ${t}`);
    }
  });
});

// ─── reader-level filters ────────────────────────────────────────────────────

describe("createJsonlTraceReader — #358 T5 taskId / parentTurnId filters", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-subagent-reader-"));
    tracePath = join(tmpDir, "trace.jsonl");
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("query({ taskId }) returns only matching task_id rows, sorted time-desc", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ taskId: "t-1" });
    assert.equal(out.total, 3);
    assert.deepEqual(
      out.records.map((r) => r["record_type"]),
      ["subagent_state_change", "subagent_spawn", "subagent_stop"]
    );
    for (const r of out.records) assert.equal(r["task_id"], "t-1");
  });

  it("query({ parentTurnId }) returns only matching parent_turn_id rows", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ parentTurnId: "p-2" });
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["task_id"], "t-2");
    assert.equal(out.records[0]?.["parent_turn_id"], "p-2");
  });

  it("combines taskId with status (AND semantics)", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ taskId: "t-2", status: "error" });
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["task_id"], "t-2");
  });

  it("subagent rows mix with other record types and sort by started_at desc (no filters)", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.equal(out.total, 5);
    assert.deepEqual(
      out.records.map((r) => r["record_type"]),
      [
        "subagent_spawn",
        "subagent_state_change",
        "subagent_spawn",
        "subagent_stop",
        "llm_call",
      ]
    );
  });

  it("legacy query without the new fields filters only by legacy predicates (向后兼容)", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ recordType: "subagent_spawn" });
    assert.equal(out.total, 2);
  });
});

// ─── HTTP-level (query param parsing + wiring) ───────────────────────────────

describe("GET /api/v1/traces — #358 T5 subagent queries", () => {
  let tmpDir: string;
  let listening: TraceListeningServer | undefined;
  let origin: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-subagent-http-"));
    // T6 (SC16): 会话落两级树 `<tmpDir>/projects/<slug>/c1/trace.jsonl`。
    const convDir = join(tmpDir, "projects", "test-project-subagent", "c1");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, "trace.jsonl"),
      lines.join("\n") + "\n",
      "utf8"
    );
    listening = await startTraceServe({
      host: "127.0.0.1",
      port: 0,
      traceOut: tmpDir,
    });
    origin = `http://${listening.host}:${listening.port}`;
  });

  afterEach(async () => {
    if (listening) await listening.close();
    listening = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getJson(
    p: string
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${origin}${p}`);
    return { status: res.status, body: (await res.json()) as unknown };
  }

  it("accepts record_type=subagent_spawn (parseRecordType whitelist)", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&record_type=subagent_spawn"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 2);
    for (const r of out.records)
      assert.equal(r["record_type"], "subagent_spawn");
  });

  it("filters by task_id exactly", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&task_id=t-1"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 3);
    for (const r of out.records) assert.equal(r["task_id"], "t-1");
  });

  it("filters by parent_turn_id exactly", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&parent_turn_id=p-2"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["task_id"], "t-2");
  });

  it("combines task_id with record_type (AND semantics)", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&task_id=t-1&record_type=subagent_stop"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["record_type"], "subagent_stop");
  });

  it("combines task_id with status (AND semantics)", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&task_id=t-2&status=error"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["task_id"], "t-2");
  });

  it("legacy filter combination behaves unchanged without the new fields", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&record_type=llm_call"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["record_type"], "llm_call");
  });

  it("returns 400 validation for empty task_id", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&task_id="
    );
    assert.equal(status, 400);
    const b = body as { error?: { kind: string; field?: string } };
    assert.equal(b.error?.kind, "validation");
    assert.equal(b.error?.field, "task_id");
  });

  it("returns 400 validation for empty parent_turn_id", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&parent_turn_id="
    );
    assert.equal(status, 400);
    const b = body as { error?: { kind: string; field?: string } };
    assert.equal(b.error?.kind, "validation");
    assert.equal(b.error?.field, "parent_turn_id");
  });
});

// ─── field defs ──────────────────────────────────────────────────────────────

describe("TRACE_FIELD_DEFS — #358 T5 subagent columns", () => {
  const byKey = new Map<string, TraceFieldDef>(
    TRACE_FIELD_DEFS.map((d) => [d.key, d])
  );
  const subagentTypes = [
    "subagent_spawn",
    "subagent_stop",
    "subagent_state_change",
  ] as const;

  it("declares subagentId / taskId / origin for all three subagent record types", () => {
    assert.deepEqual(
      byKey.get("subagentId")?.recordTypes,
      subagentTypes,
      "subagentId scope"
    );
    // taskId / origin 是关联列, 后加的 subagent_step 也带这两个键 (配对键仍是
    // task_id); subagentId 刻意不覆盖 step —— step 的 id 载体是 subagentStepId。
    for (const key of ["taskId", "origin"] as const) {
      const def = byKey.get(key);
      assert.ok(def, `${key} must be declared`);
      assert.deepEqual(
        def.recordTypes,
        [...subagentTypes, "subagent_step"],
        `${key} scope`
      );
    }
    assert.equal(byKey.get("subagentId")?.jsonlKey, "subagent_id");
    assert.equal(byKey.get("taskId")?.jsonlKey, "task_id");
    assert.equal(byKey.get("origin")?.jsonlKey, "origin");
    assert.deepEqual(byKey.get("origin")?.options, ["parent", "child"]);
  });

  it("scopes fromState/toState to subagent_state_change and finalState to subagent_stop", () => {
    assert.deepEqual(byKey.get("fromState")?.recordTypes, [
      "subagent_state_change",
    ]);
    assert.deepEqual(byKey.get("toState")?.recordTypes, [
      "subagent_state_change",
    ]);
    assert.deepEqual(byKey.get("finalState")?.recordTypes, ["subagent_stop"]);
    assert.deepEqual(byKey.get("fromState")?.options, [
      "starting",
      "running",
      "completed",
      "failed",
    ]);
    assert.deepEqual(byKey.get("finalState")?.options, ["completed", "failed"]);
  });

  it("declares reason with the subagent stop-reason enum across stop + state_change", () => {
    const reason = byKey.get("reason");
    assert.ok(reason, "reason must be declared");
    assert.deepEqual(reason.recordTypes, [
      "subagent_stop",
      "subagent_state_change",
    ]);
    for (const v of [
      "crashed",
      "maxTurnsExceeded",
      "timeout",
      "protocolError",
      "cancelled",
    ]) {
      assert.ok(reason.options?.includes(v), `reason must offer ${v}`);
    }
  });

  it("extends shared / sandbox-column defs to the subagent record types", () => {
    assert.ok(
      byKey.get("parentTurnId")?.recordTypes.includes("subagent_spawn")
    );
    assert.ok(byKey.get("parentTurnId")?.recordTypes.includes("subagent_stop"));
    assert.ok(byKey.get("exitCode")?.recordTypes.includes("subagent_stop"));
    assert.ok(byKey.get("startedAt")?.recordTypes.includes("subagent_spawn"));
    assert.ok(
      byKey.get("status")?.recordTypes.includes("subagent_state_change")
    );
    assert.ok(byKey.get("ts")?.recordTypes.includes("subagent_stop"));
  });

  it("extends the record_type field def options + recordTypes to the three literals", () => {
    const recordType = byKey.get("recordType");
    assert.ok(recordType);
    for (const t of subagentTypes) {
      assert.ok(recordType.recordTypes.includes(t));
      assert.ok(recordType.options?.includes(t));
    }
  });

  it("keeps key / jsonlKey globally unique (module-load self-check)", () => {
    const keys = TRACE_FIELD_DEFS.map((d) => d.key);
    const jsonlKeys = TRACE_FIELD_DEFS.map((d) => d.jsonlKey);
    assert.equal(new Set(keys).size, keys.length, "keys unique");
    assert.equal(new Set(jsonlKeys).size, jsonlKeys.length, "jsonlKeys unique");
  });
});
