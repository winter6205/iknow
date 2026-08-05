/**
 * GET /api/v1/traces (and /api/v1/traces/fields) integration tests (post #183).
 *
 * Boots the standalone trace server via `startTraceServe` on 127.0.0.1:0;
 * exercises the endpoints with fetch and asserts the nested wire shape
 * (records / total / skipped_lines / truncated).
 *
 * Categories (S2 defensive contract):
 *   - 200 happy path with snake_case wire keys
 *   - filtering: record_type / status / conversation_id
 *   - pagination: limit + offset; total before slicing
 *   - 400 validation: limit=-1 / limit=0 / limit=abc / limit=2.5 / limit=201 /
 *                     offset=-1 / record_type=garbage / status=garbage /
 *                     conversation_id= (empty)
 *   - 500 internal when traceFilePath points at a directory (TraceReadError)
 *   - 404 not_found when traceFilePath is not configured
 *   - /fields endpoint: 200 with TRACE_FIELD_DEFS shape, available even
 *     without traceFilePath
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

// -- per-test server lifecycle ------------------------------------------------

const tmpDirs: string[] = [];
let listening: TraceListeningServer | undefined;
let origin: string;

interface StartOpts {
  readonly traceOut?: string | undefined;
}

async function startServer(startOpts: StartOpts = {}): Promise<void> {
  listening = await startTraceServe({
    host: "127.0.0.1",
    port: 0,
    ...(startOpts.traceOut !== undefined
      ? { traceOut: startOpts.traceOut }
      : {}),
  });
  origin = `http://${listening.host}:${listening.port}`;
}

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// -- helpers ------------------------------------------------------------------

interface TraceRow {
  readonly [key: string]: unknown;
}

function writeSampleTrace(path: string): void {
  const lines: string[] = [
    JSON.stringify({
      conversation_id: "c1",
      record_type: "turn",
      turn_id: "t-0",
      turn_index: 0,
      started_at: "2026-08-01T01:00:00.000Z",
      ended_at: "2026-08-01T01:00:01.000Z",
      duration_ms: 1000,
      llm_call_ids: [],
      tool_call_ids: [],
      decision: "completed",
      status: "ok",
    }),
    JSON.stringify({
      conversation_id: "c1",
      record_type: "llm_call",
      llm_call_id: "l-0",
      started_at: "2026-08-01T01:00:00.500Z",
      ended_at: "2026-08-01T01:00:00.700Z",
      duration_ms: 200,
      supplier_stop: "success",
      stream: false,
      messages_captured: false,
      status: "ok",
    }),
    JSON.stringify({
      conversation_id: "c2",
      record_type: "tool_call",
      tool_call_id: "tc-0",
      parent_llm_call_id: null,
      tool_name: "kb_search",
      tool_kind: "ok",
      started_at: "2026-08-01T02:00:00.000Z",
      ended_at: "2026-08-01T02:00:00.005Z",
      duration_ms: 5,
      arguments_captured: false,
      result_captured: false,
      status: "error",
    }),
    "{not-json",
    "42",
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

async function getJson(p: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${p}`);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

function asTraceBody(body: unknown): {
  records: TraceRow[];
  total: number;
  skipped_lines: number;
  truncated: boolean;
} {
  const b = body as Record<string, unknown>;
  return {
    records: (b["records"] as TraceRow[]) ?? [],
    total: (b["total"] as number) ?? -1,
    skipped_lines: (b["skipped_lines"] as number) ?? -1,
    truncated: (b["truncated"] as boolean) ?? false,
  };
}

function assertNestedError(body: unknown, kind: string): void {
  const b = body as { error?: { kind?: string; message?: string } };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.equal(typeof b.error!.message, "string");
  assert.ok((b.error!.message ?? "").length > 0);
}

// -- 404 when no trace file configured ----------------------------------------

describe("GET /api/v1/traces — no traceOut configured", () => {
  beforeEach(async () => {
    await startServer();
  });

  it("returns 404 not_found with a descriptive message", async () => {
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 404);
    assertNestedError(body, "not_found");
  });

  it("still serves /api/v1/traces/fields when no trace file is configured", async () => {
    const { status, body } = await getJson("/api/v1/traces/fields");
    assert.equal(status, 200);
    const b = body as { fields?: Array<{ key: string; jsonlKey: string }> };
    assert.ok(Array.isArray(b.fields), "fields must be an array");
    const keys = new Set((b.fields ?? []).map((f) => f.jsonlKey));
    for (const expected of [
      "conversation_id",
      "record_type",
      "duration_ms",
      "status",
      "started_at",
    ]) {
      assert.ok(keys.has(expected), `fields must include jsonlKey ${expected}`);
    }
  });
});

// -- 200 happy path + filtering + pagination ---------------------------------

describe("GET /api/v1/traces — happy path + filtering + pagination", () => {
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-happy-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    await startServer({ traceOut: file });
  });

  it("returns records in descending order with snake_case wire shape", async () => {
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 3, "two bad lines skipped");
    assert.equal(out.skipped_lines, 2);
    assert.equal(out.truncated, false);
    assert.equal(out.records.length, 3);
    // Order: tool_call c2 (02:00) → llm_call c1 (01:00.5) → turn c1 (01:00)
    assert.equal(out.records[0]?.["record_type"], "tool_call");
    assert.equal(out.records[1]?.["record_type"], "llm_call");
    assert.equal(out.records[2]?.["record_type"], "turn");
  });

  it("filters by record_type", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?record_type=llm_call"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["record_type"], "llm_call");
  });

  it("filters by status", async () => {
    const { status, body } = await getJson("/api/v1/traces?status=error");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["status"], "error");
  });

  it("filters by conversation_id", async () => {
    const { status, body } = await getJson("/api/v1/traces?conversation_id=c1");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 2);
    for (const r of out.records) assert.equal(r["conversation_id"], "c1");
  });

  it("applies limit + offset, total counts filtered before slicing", async () => {
    const { status, body } = await getJson("/api/v1/traces?limit=1&offset=1");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 3);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["record_type"], "llm_call");
  });
});

// -- 400 validation -----------------------------------------------------------

describe("GET /api/v1/traces — validation errors", () => {
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-validation-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    await startServer({ traceOut: file });
  });

  const cases: Array<[string, string]> = [
    ["limit=-1", "limit"],
    ["limit=0", "limit"],
    ["limit=abc", "limit"],
    ["limit=2.5", "limit"],
    ["limit=201", "limit"],
    ["offset=-1", "offset"],
    ["record_type=garbage", "record_type"],
    ["status=garbage", "status"],
    ["conversation_id=", "conversation_id"],
  ];
  for (const [qs, expectedField] of cases) {
    it(`returns 400 validation for ?${qs}`, async () => {
      const { status, body } = await getJson(`/api/v1/traces?${qs}`);
      assert.equal(status, 400);
      const b = body as {
        error?: { kind: string; message: string; field?: string };
      };
      assert.equal(b.error?.kind, "validation");
      assert.equal(b.error?.field, expectedField);
      assert.ok(b.error?.message && b.error.message.length > 0);
    });
  }
});

// -- 500 internal when traceFilePath is a directory ---------------------------

describe("GET /api/v1/traces — IO error mapping", () => {
  it("returns 500 internal when traceOut points at a directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-io-"));
    tmpDirs.push(tmp);
    // Use a directory path as the traceOut → reader throws TraceReadError.
    await startServer({ traceOut: tmp });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 500);
    const b = body as { error?: { kind: string; message: string } };
    assert.equal(b.error?.kind, "internal");
    assert.equal(typeof b.error?.message, "string");
  });
});

// -- /fields endpoint shape ---------------------------------------------------

describe("GET /api/v1/traces/fields", () => {
  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-fields-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    await startServer({ traceOut: file });
  });

  it("returns each field def with key, jsonlKey, type, label, recordTypes", async () => {
    const { status, body } = await getJson("/api/v1/traces/fields");
    assert.equal(status, 200);
    const b = body as {
      fields: Array<{
        key: string;
        jsonlKey: string;
        type: string;
        label: string;
        recordTypes: string[];
        options?: string[];
      }>;
    };
    assert.ok(b.fields.length > 0);
    for (const f of b.fields) {
      assert.equal(typeof f.key, "string");
      assert.equal(typeof f.jsonlKey, "string");
      assert.ok(
        ["string", "number", "boolean", "enum", "datetime"].includes(f.type)
      );
      assert.equal(typeof f.label, "string");
      assert.ok(Array.isArray(f.recordTypes));
    }
  });

  it("includes enum options for record_type and decision", async () => {
    const { body } = await getJson("/api/v1/traces/fields");
    const b = body as {
      fields: Array<{
        jsonlKey: string;
        options?: string[];
      }>;
    };
    const recordType = b.fields.find((f) => f.jsonlKey === "record_type");
    assert.ok(recordType?.options?.includes("llm_call"));
    assert.ok(recordType?.options?.includes("tool_call"));
    const decision = b.fields.find((f) => f.jsonlKey === "decision");
    assert.ok(decision?.options?.includes("completed"));
    assert.ok(decision?.options?.includes("protocolError"));
  });

  it('declares tone: "status" on the status field (declarative colouring rule)', async () => {
    const { body } = await getJson("/api/v1/traces/fields");
    const b = body as {
      fields: Array<{ jsonlKey: string; tone?: string }>;
    };
    const status = b.fields.find((f) => f.jsonlKey === "status");
    assert.equal(status?.tone, "status");
  });
});
