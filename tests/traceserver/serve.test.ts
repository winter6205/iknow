/**
 * `startTraceServe` HTTP integration tests (v2 directory semantics).
 *
 * Boots the standalone trace inspection server on 127.0.0.1:0 (ephemeral),
 * exercises the endpoints with fetch, and asserts wire shape:
 *   - GET /api/v1/health     -> { ok: true, service: "iknow-trace", version: <nonempty> }
 *   - GET /api/v1/traces      -> { records, total, skipped_lines, truncated }
 *   - GET /api/v1/traces/fields -> { fields: [...] }
 *
 * Also covers `webRoot` option (trace SPA hosting — separate trace.html
 * block added when the trace process began hosting its own inspection panel).
 *
 * Categories (S2 defensive contract):
 *   - 200 happy path on all three endpoints
 *   - 400 validation on bad query params (limit=0)
 *   - 500 internal when traceOut points at a regular file (TraceReadError)
 *   - 404 not_found when no trace out is configured (traceOut: undefined)
 *   - error shape: { error: { kind, message } } — no fs detail leak on 500
 *   - webRoot passthrough + default (resolveDefaultWebRoot used when omitted)
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

// -- per-test server lifecycle ------------------------------------------------

const tmpDirs: string[] = [];
/**
 * T6 (SC16): all sessions sit at
 *   `<dir>/projects/<slug>/<convId>/trace.jsonl`.
 */
const TEST_PROJECT_SLUG = "test-project-serve";
let listening: TraceListeningServer | undefined;
let origin: string;

interface StartOpts {
  readonly traceOut?: string | undefined;
  readonly maxBytes?: number;
  readonly webRoot?: string;
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
    ...(startOpts.webRoot !== undefined ? { webRoot: startOpts.webRoot } : {}),
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

/**
 * Write a single-session trace directory (v2: one file per session):
 * `<dir>/c1.jsonl` with 2 good lines + 2 bad lines.
 * The default /api/v1/traces routes to the only session.
 */
function writeSampleTraceDir(dir: string): void {
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
  mkdirSync(join(dir, "projects", TEST_PROJECT_SLUG, "c1"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "projects", TEST_PROJECT_SLUG, "c1", "trace.jsonl"),
    lines.join("\n") + "\n",
    "utf8"
  );
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
    await startServer({ traceOut: tmp });
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
    writeSampleTraceDir(tmp);
    await startServer({ traceOut: tmp });
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

  it("returns 404 not_found when no trace out is configured", async () => {
    await startServer();
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 404);
    assertNestedError(body, "not_found");
  });

  // End-to-end regression for review finding: `--max-bytes` must reach the
  // JSONL reader (not be silently dropped at the serve layer). With a 200-byte
  // cap and a session file whose lines are ~90 bytes, the response must report
  // truncated=true and drop at least one record. maxBytes applies per session file.
  it("honors maxBytes (truncates + drops records past the cap)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-mb-"));
    tmpDirs.push(tmp);
    writeSampleTraceDir(tmp);
    await startServer({ traceOut: tmp, maxBytes: 200 });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const b = body as {
      records: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
    };
    assert.equal(b.truncated, true, `truncated flag set under a 200-byte cap`);
    assert.ok(
      b.records.length < 2,
      `some rows dropped (got ${b.records.length})`
    );
  });

  it("returns 400 validation for limit=0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-400-"));
    tmpDirs.push(tmp);
    writeSampleTraceDir(tmp);
    await startServer({ traceOut: tmp });
    const { status, body } = await getJson("/api/v1/traces?limit=0");
    assert.equal(status, 400);
    const b = body as { error: { kind: string; field?: string } };
    assert.equal(b.error.kind, "validation");
    assert.equal(b.error.field, "limit");
  });

  it("returns 500 internal when traceOut points at a regular file (no fs leak)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-eisdir-"));
    tmpDirs.push(tmp);
    const file = join(tmp, "not-a-dir.jsonl");
    writeFileSync(file, "{}\n", "utf8");
    await startServer({ traceOut: file });
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
      b.error.message.toLowerCase().includes(file.toLowerCase()),
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

// -- webRoot option (trace SPA hosting) ---------------------------------------
//
// The trace process serves its own inspection panel (trace.html) via the
// shared static-serve helper (src/web/serve-static.ts). These tests confirm
// that:
//   - a custom webRoot is honored (passthrough)
//   - the default webRoot is used when omitted
//   - API routes still win over static (regression guard for /api priority)
//   - missing trace.html under webRoot degrades to 404 JSON (caller-404 path)
// See tests/traceserver/serve-static.test.ts for the broader static-serve
// coverage (helper direct + MIME + traversal 403 + SPA fallback + asset).

describe("startTraceServe — webRoot option", () => {
  it("honors a custom webRoot and serves trace.html on GET /", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-webroot-"));
    tmpDirs.push(tmp);
    writeFileSync(
      join(tmp, "trace.html"),
      '<!doctype html><title>iknow trace</title><div id="root">trace-spa</div>',
      "utf8"
    );
    await startServer({ webRoot: tmp });
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("text/html"),
      `expected text/html, got ${res.headers.get("content-type")}`
    );
    const body = await res.text();
    assert.ok(
      body.includes("trace-spa") || body.includes('<div id="root">'),
      `expected trace.html body, got: ${body.slice(0, 80)}`
    );
  });

  it("falls back to resolveDefaultWebRoot() when webRoot is omitted", async () => {
    // No webRoot passed → server should still bind and serve something on
    // GET / (either trace.html if web/dist contains it, or a 404 JSON if not).
    // We only assert the API side stays reachable; the static side is covered
    // by serve-static.test.ts. The contract here is that omitting webRoot
    // does NOT crash startup.
    await startServer();
    const { status } = await getJson("/api/v1/health");
    assert.equal(
      status,
      200,
      "API routes must remain reachable without webRoot"
    );
  });

  it("keeps /api/v1/* priority over static (regression guard)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-webroot-api-"));
    tmpDirs.push(tmp);
    writeFileSync(
      join(tmp, "trace.html"),
      '<!doctype html><title>iknow trace</title><div id="root">trace-spa</div>',
      "utf8"
    );
    await startServer({ webRoot: tmp });
    const res = await fetch(`${origin}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("application/json"),
      "health must be JSON even when webRoot + trace.html are present"
    );
    const body = (await res.json()) as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "iknow-trace");
  });

  it("returns 404 JSON when webRoot has no trace.html (caller-404 path)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-trace-serve-webroot-empty-"));
    tmpDirs.push(tmp);
    // No trace.html under tmp.
    await startServer({ webRoot: tmp });
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 404);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("application/json")
    );
    const body = (await res.json()) as { error?: { kind?: string } };
    assert.equal(body.error?.kind, "not_found");
  });
});
