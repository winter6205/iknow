/**
 * GET /api/v1/traces (+ /fields + /sessions) integration tests (post #183 + v2).
 *
 * Boots the standalone trace server via `startTraceServe` on 127.0.0.1:0;
 * exercises the endpoints with fetch and asserts the nested wire shape
 * (records / total / skipped_lines / truncated / offset).
 *
 * v2 directory semantics: traceOut is a "one file per session" directory;
 * /api/v1/traces?conversation_id=<id> routes to `<traceDir>/<id>.jsonl`,
 * default → most-recently-active session (readdir+stat by mtime), never 400, never mixed.
 *
 * Categories (S2 defensive contract):
 *   - 200 happy path with snake_case wire keys (default → most-recent session)
 *   - filtering: record_type / status / conversation_id (drill down, no mixing)
 *   - pagination: limit + offset; total before slicing
 *   - default conversation_id → most-recent session (by mtime)
 *   - /sessions: list returns conversation_id/mtime/size/agent_version; no traceOut → 404
 *   - poll: 0/500 → 200; -1/abc/2.5 → 400 validation (field poll)
 *   - resume_offset: 0 → 200; -1/abc → 400 validation (field resume_offset)
 *   - 400 validation: limit/offset/record_type/status/conversation_id
 *   - 500 internal when traceOut points at a regular file (TraceReadError)
 *   - 404 not_found when traceOut is not configured
 *   - /fields endpoint: 200 with TRACE_FIELD_DEFS shape, available even
 *     without traceOut
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
 * Same slug across every test (one project, multiple conversations).
 */
const TEST_PROJECT_SLUG = "test-project-http";
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

function sessionRootLine(convId: string, agentVersion?: string): string {
  return JSON.stringify({
    conversation_id: convId,
    record_type: "session",
    session_id: `s-${convId}`,
    started_at: "2026-08-01T00:00:00.000Z",
    ended_at: "2026-08-01T00:00:01.000Z",
    duration_ms: 1000,
    status: "ok",
    ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
  });
}

function writeSessionFile(dir: string, convId: string, lines: string[]): void {
  const path = join(dir, "projects", TEST_PROJECT_SLUG, convId, "trace.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Write two session files: c2 first with mtime rolled back (older), c1 second
 * (newer = most active). c1 holds turn + llm_call + 2 bad lines; c2 holds a
 * tool_call error. So the default /api/v1/traces always routes to c1, decoupled
 * from the 「不混看」 ("no mixing") assertions.
 */
function writeSampleTraceDir(dir: string): void {
  writeSessionFile(dir, "c2", [
    JSON.stringify({
      conversation_id: "c2",
      record_type: "tool_call",
      tool_call_id: "tc-0",
      parent_llm_call_id: null,
      tool_name: "grep",
      tool_kind: "ok",
      started_at: "2026-08-01T02:00:00.000Z",
      ended_at: "2026-08-01T02:00:00.005Z",
      duration_ms: 5,
      arguments_captured: false,
      result_captured: false,
      status: "error",
    }),
  ]);
  // Roll back c2's mtime so c1 stays the most active.
  utimesSync(
    join(dir, "projects", TEST_PROJECT_SLUG, "c2", "trace.jsonl"),
    new Date(0),
    new Date(0)
  );

  writeSessionFile(dir, "c1", [
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
  ]);
}

function makeTraceDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-"));
  tmpDirs.push(tmp);
  writeSampleTraceDir(tmp);
  return tmp;
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
  offset: number;
} {
  const b = body as Record<string, unknown>;
  return {
    records: (b["records"] as TraceRow[]) ?? [],
    total: (b["total"] as number) ?? -1,
    skipped_lines: (b["skipped_lines"] as number) ?? -1,
    truncated: (b["truncated"] as boolean) ?? false,
    offset: (b["offset"] as number) ?? -1,
  };
}

function assertNestedError(body: unknown, kind: string): void {
  const b = body as { error?: { kind?: string; message?: string } };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.equal(typeof b.error!.message, "string");
  assert.ok((b.error!.message ?? "").length > 0);
}

// -- 404 when no trace out configured -----------------------------------------

describe("GET /api/v1/traces — no traceOut configured", () => {
  beforeEach(async () => {
    await startServer();
  });

  it("returns 404 not_found with a descriptive message", async () => {
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 404);
    assertNestedError(body, "not_found");
  });

  it("still serves /api/v1/traces/fields when no trace out is configured", async () => {
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

  it("GET /api/v1/sessions returns 404 when no traceOut configured", async () => {
    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 404);
    assertNestedError(body, "not_found");
  });
});

// -- 200 happy path + filtering + pagination ---------------------------------

describe("GET /api/v1/traces — happy path + filtering + pagination", () => {
  beforeEach(async () => {
    const dir = makeTraceDir();
    await startServer({ traceOut: dir });
  });

  it("defaults to the most-recent session and returns snake_case wire shape", async () => {
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 2, "c1: two good rows, two bad lines skipped");
    assert.equal(out.skipped_lines, 2);
    assert.equal(out.truncated, false);
    assert.equal(out.records.length, 2);
    assert.ok(
      out.offset > 0,
      "response carries a byte offset for the next poll"
    );
    // Order within c1: llm_call (01:00.5) → turn (01:00)
    assert.equal(out.records[0]?.["record_type"], "llm_call");
    assert.equal(out.records[1]?.["record_type"], "turn");
    for (const r of out.records) assert.equal(r["conversation_id"], "c1");
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

  it("filters by status within the routed session", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c2&status=error"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["status"], "error");
    assert.equal(out.records[0]?.["conversation_id"], "c2");
  });

  it("routes by conversation_id (下钻不混看)", async () => {
    const { status, body } = await getJson("/api/v1/traces?conversation_id=c2");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    for (const r of out.records) assert.equal(r["conversation_id"], "c2");
  });

  it("filters by conversation_id within the routed session", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=c1&record_type=turn"
    );
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["record_type"], "turn");
  });

  it("applies limit + offset, total counts filtered before slicing", async () => {
    const { status, body } = await getJson("/api/v1/traces?limit=1&offset=1");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 2, "c1 has two rows before slicing");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["record_type"], "turn");
  });
});

// -- default conversation_id → most-recent session ----------------------------

describe("GET /api/v1/traces — default conversation_id → most-recent session", () => {
  it("routes to the session with the newest mtime when conversation_id is absent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-default-"));
    tmpDirs.push(tmp);
    // Older session (mtime rolled back).
    writeSessionFile(tmp, "old", [
      JSON.stringify({
        conversation_id: "old",
        record_type: "llm_call",
        llm_call_id: "o-1",
        started_at: "2026-08-01T00:00:01.000Z",
        status: "ok",
      }),
    ]);
    utimesSync(
      join(tmp, "projects", TEST_PROJECT_SLUG, "old", "trace.jsonl"),
      new Date(0),
      new Date(0)
    );
    // Newer session (most active).
    writeSessionFile(tmp, "new", [
      JSON.stringify({
        conversation_id: "new",
        record_type: "llm_call",
        llm_call_id: "n-1",
        started_at: "2026-08-01T01:00:01.000Z",
        status: "ok",
      }),
    ]);
    await startServer({ traceOut: tmp });

    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(
      out.records[0]?.["conversation_id"],
      "new",
      "缺省路由到最近活跃会话"
    );
  });

  it("returns an empty result (200) when the trace dir has no session files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-empty-dir-"));
    tmpDirs.push(tmp);
    await startServer({ traceOut: tmp });
    const { status, body } = await getJson("/api/v1/traces");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.deepEqual(out.records, []);
    assert.equal(out.total, 0);
    assert.equal(out.offset, 0);
  });

  it("routes to the session file even when conversation_id names an existing file", async () => {
    const tmp = makeTraceDir();
    await startServer({ traceOut: tmp });
    const { body } = await getJson("/api/v1/traces?conversation_id=c2");
    const out = asTraceBody(body);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["conversation_id"], "c2");
  });
});

// -- GET /api/v1/sessions -----------------------------------------------------

describe("GET /api/v1/sessions — session list", () => {
  it("returns conversation_id / mtime / size / agent_version per session", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-sessions-list-"));
    tmpDirs.push(tmp);
    writeSessionFile(tmp, "uuid-a", [
      sessionRootLine("uuid-a", "1.2.3"),
      JSON.stringify({ conversation_id: "uuid-a", record_type: "turn" }),
    ]);
    writeSessionFile(tmp, "uuid-b", [sessionRootLine("uuid-b")]);
    await startServer({ traceOut: tmp });

    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 200);
    const b = body as {
      sessions: Array<{
        conversation_id: string;
        mtime: number;
        size: number;
        agent_version?: string;
      }>;
    };
    assert.ok(Array.isArray(b.sessions));
    assert.equal(b.sessions.length, 2);
    const byId = new Map(b.sessions.map((s) => [s.conversation_id, s]));
    assert.ok(byId.has("uuid-a") && byId.has("uuid-b"));
    const a = byId.get("uuid-a")!;
    assert.equal(a.agent_version, "1.2.3");
    assert.equal(typeof a.mtime, "number");
    assert.equal(typeof a.size, "number");
    assert.ok(a.size > 0);
    const bb = byId.get("uuid-b")!;
    assert.ok(
      !("agent_version" in bb),
      "agent_version absent when root lacks it"
    );
  });

  it("empty trace dir → empty session list", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-sessions-empty-"));
    tmpDirs.push(tmp);
    await startServer({ traceOut: tmp });
    const { status, body } = await getJson("/api/v1/sessions");
    assert.equal(status, 200);
    const b = body as { sessions: unknown[] };
    assert.deepEqual(b.sessions, []);
  });
});

// -- poll + resume_offset -----------------------------------------------------

describe("GET /api/v1/traces — poll param (SC-R 14 / SC-V 26)", () => {
  beforeEach(async () => {
    const dir = makeTraceDir();
    await startServer({ traceOut: dir });
  });

  it("accepts poll=0 (stop polling) and poll=500", async () => {
    for (const poll of ["0", "500"]) {
      const { status, body } = await getJson(`/api/v1/traces?poll=${poll}`);
      assert.equal(status, 200, `poll=${poll} must be 200`);
      const out = asTraceBody(body);
      assert.equal(out.total, 2);
      assert.ok(out.offset > 0);
    }
  });

  it("returns 400 validation for poll negative / non-integer / NaN", async () => {
    const cases: Array<[string]> = [["poll=-1"], ["poll=abc"], ["poll=2.5"]];
    for (const [qs] of cases) {
      const { status, body } = await getJson(`/api/v1/traces?${qs}`);
      assert.equal(status, 400, `${qs} must be 400`);
      const b = body as {
        error?: { kind: string; message: string; field?: string };
      };
      assert.equal(b.error?.kind, "validation");
      assert.equal(b.error?.field, "poll");
      assert.ok(b.error?.message && b.error.message.length > 0);
    }
  });

  it("returns 400 validation for resume_offset negative / non-integer", async () => {
    for (const qs of ["resume_offset=-1", "resume_offset=abc"]) {
      const { status, body } = await getJson(`/api/v1/traces?${qs}`);
      assert.equal(status, 400, `${qs} must be 400`);
      const b = body as { error?: { kind: string; field?: string } };
      assert.equal(b.error?.kind, "validation");
      assert.equal(b.error?.field, "resume_offset");
    }
  });

  it("accepts resume_offset=0 (fresh read) and echoes a new offset", async () => {
    const { status, body } = await getJson("/api/v1/traces?resume_offset=0");
    assert.equal(status, 200);
    const out = asTraceBody(body);
    assert.equal(out.total, 2);
    assert.ok(out.offset > 0);
  });
});

// -- 400 validation -----------------------------------------------------------

describe("GET /api/v1/traces — validation errors", () => {
  beforeEach(async () => {
    const dir = makeTraceDir();
    await startServer({ traceOut: dir });
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

  it("rejects conversation_id containing a path separator (traversal guard)", async () => {
    const { status, body } = await getJson(
      "/api/v1/traces?conversation_id=..%2F..%2Fetc"
    );
    assert.equal(status, 400);
    const b = body as { error?: { kind: string; field?: string } };
    assert.equal(b.error?.kind, "validation");
    assert.equal(b.error?.field, "conversation_id");
  });
});

// -- 500 internal when traceOut is a regular file -----------------------------

describe("GET /api/v1/traces — IO error mapping", () => {
  it("returns 500 internal when traceOut points at a regular file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iknow-traces-io-"));
    tmpDirs.push(tmp);
    // traceOut is a regular file (not a directory) → listSessions readdir
    // ENOTDIR → TraceReadError → 500 (no fs details leaked).
    const file = join(tmp, "not-a-dir.jsonl");
    writeFileSync(file, "{}\n", "utf8");
    await startServer({ traceOut: file });
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
    const dir = makeTraceDir();
    await startServer({ traceOut: dir });
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
