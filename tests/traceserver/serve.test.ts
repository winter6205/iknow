/**
 * `startTraceServe` HTTP integration tests (spec #183 R1).
 *
 * Boots the standalone trace inspection server on 127.0.0.1:0 (ephemeral),
 * exercises the three endpoints with fetch, and asserts wire shape:
 *   - GET /api/v1/health     -> { ok: true, service: "iknow-trace", version: <nonempty> }
 *   - GET /api/v1/traces      -> { records, total, skipped_lines, truncated }
 *   - GET /api/v1/traces/fields -> { fields: [...] }
 *
 * Categories (S2 defensive contract):
 *   - 200 happy path on all three endpoints
 *   - 400 validation on bad query params (limit=0)
 *   - 500 internal when traceFilePath points at a directory (TraceReadError)
 *   - 404 not_found when no trace file is configured (traceOut: undefined)
 *   - error shape: { error: { kind, message } } — no fs detail leak on 500
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  readonly maxBytes?: number;
}

async function startServer(startOpts: StartOpts = {}): Promise<void> {
  const out = await startTraceServe({
    host: "127.0.0.1",
    port: 0,
    ...(startOpts.traceOut !== undefined
      ? { traceOut: startOpts.traceOut }
      : {}),
    ...(startOpts.maxBytes !== undefined
      ? { maxBytes: startOpts.maxBytes }
      : {}),
  });
  listening = out;
  origin = `http://${listening.host}:${listening.port}`;
}

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// -- helpers ------------------------------------------------------------------

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

function assertNestedError(body: unknown, kind: string): void {
  const b = body as { error?: { kind?: string; message?: string } };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.equal(typeof b.error!.message, "string");
  assert.ok((b.error!.message ?? "").length > 0);
}

// -- /health endpoint ---------------------------------------------------------

describe("startTraceServe — GET /api/v1/health", () => {
  it("returns 200 with service=iknow-trace and a non-empty version", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-health-"));
    tmpDirs.push(tmp);
    await startServer({ traceOut: join(tmp, "trace.jsonl") });
    const { status, body } = await getJson("/api/v1/health");
    assert.equal(status, 200);
    const b = body as { ok: boolean; service: string; version: string };
    assert.equal(b.ok, true);
    assert.equal(b.service, "iknow-trace");
    assert.equal(typeof b.version, "string");
    assert.ok(b.version.length > 0);
  });

  it("works with no traceOut configured (404 panel decision is per-route)", async () => {
    await startServer();
    const { status, body } = await getJson("/api/v1/health");
    assert.equal(status, 200);
    const b = body as { ok: boolean; service: string };
    assert.equal(b.ok, true);
    assert.equal(b.service, "iknow-trace");
  });
});

// -- /api/v1/traces endpoint --------------------------------------------------

describe("startTraceServe — GET /api/v1/traces", () => {
  it("returns 200 with snake_case body when a populated JSONL is readable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-happy-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    await startServer({ traceOut: file });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const b = body as {
      records: Array<Record<string, unknown>>;
      total: number;
      skipped_lines: number;
      truncated: boolean;
    };
    assert.equal(b.total, 2, "two bad lines skipped");
    assert.equal(b.skipped_lines, 2);
    assert.equal(b.truncated, false);
    assert.equal(b.records.length, 2);
    // descending order: llm_call (01:00.5) → turn (01:00)
    assert.equal(b.records[0]?.["record_type"], "llm_call");
    assert.equal(b.records[1]?.["record_type"], "turn");
  });

  it("returns 404 not_found when no trace file is configured", async () => {
    await startServer();
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 404);
    assertNestedError(body, "not_found");
  });

  // End-to-end regression for review finding: `--max-bytes` must reach the
  // JSONL reader (not be silently dropped at the serve layer). With a 200-byte
  // cap and a 3-row JSONL whose lines are ~50 bytes, the response must report
  // truncated=true and drop at least one record.
  it("honors maxBytes (truncates + drops records past the cap)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-mb-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    const beforeStat = statSync(file).size;
    await startServer({ traceOut: file, maxBytes: 200 });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const b = body as {
      records: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
    };
    assert.equal(
      b.truncated,
      true,
      `truncated flag set (file was ${beforeStat}B)`
    );
    assert.ok(
      b.records.length < 3,
      `some rows dropped (got ${b.records.length})`
    );
  });

  it("returns 400 validation for limit=0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-400-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "trace.jsonl");
    writeSampleTrace(file);
    await startServer({ traceOut: file });
    const { status, body } = await getJson("/api/v1/traces?limit=0");
    assert.equal(status, 400);
    const b = body as { error: { kind: string; field?: string } };
    assert.equal(b.error.kind, "validation");
    assert.equal(b.error.field, "limit");
  });

  it("returns 500 internal when traceFilePath points at a directory (no fs leak)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-eisdir-"));
    tmpDirs.push(tmp);
    await startServer({ traceOut: tmp });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 500);
    const b = body as { error: { kind: string; message: string } };
    assert.equal(b.error.kind, "internal");
    // Must NOT leak fs path / EISDIR detail onto the wire.
    assert.equal(
      typeof b.error.message,
      "string",
      "500 must have a string message"
    );
    assert.ok(b.error.message.length > 0);
    assert.equal(
      b.error.message.toLowerCase().includes(tmp.toLowerCase()),
      false,
      "500 message must not leak the absolute trace file path"
    );
    assert.equal(
      b.error.message.includes("EISDIR"),
      false,
      "500 message must not leak the raw fs error code"
    );
  });
});

// -- /api/v1/traces/fields endpoint ------------------------------------------

describe("startTraceServe — GET /api/v1/traces/fields", () => {
  it("returns 200 with the field declaration table", async () => {
    await startServer();
    const { status, body } = await getJson("/api/v1/traces/fields");
    assert.equal(status, 200);
    const b = body as { fields: Array<{ jsonlKey: string }> };
    assert.ok(Array.isArray(b.fields));
    assert.ok(b.fields.length > 0);
    const keys = new Set(b.fields.map((f) => f.jsonlKey));
    for (const expected of ["conversation_id", "record_type", "duration_ms"]) {
      assert.ok(keys.has(expected), `fields must include ${expected}`);
    }
  });

  it("works even when no traceOut is configured", async () => {
    await startServer();
    const { status } = await getJson("/api/v1/traces/fields");
    assert.equal(status, 200);
  });
});

// -- handle contract ----------------------------------------------------------

describe("startTraceServe — handle contract", () => {
  it("returns { server, host, port, close } shape", async () => {
    const out = await startTraceServe({
      host: "127.0.0.1",
      port: 0,
    });
    listening = out;
    assert.ok(out.server, "server must be present");
    assert.equal(typeof out.host, "string");
    assert.equal(typeof out.port, "number");
    assert.ok(out.port > 0, "ephemeral port must be > 0");
    assert.equal(typeof out.close, "function");
  });
});
