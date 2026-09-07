/**
 * JsonlTraceReader tests (trace inspection panel, TDD-first).
 *
 * Categories covered (S2 defensive contract):
 *   - happy path: mixed rows, descending order by started_at / ts.
 *   - filtering: conversation_id / record_type / status (exact match).
 *   - pagination: limit + offset, `total` reflects filtered count before slicing.
 *   - corrupt lines: skippedLines counted (invalid JSON, scalars, arrays, null).
 *   - empty file: zero rows, zero skipped, no throw.
 *   - missing file: ENOENT → empty result, no throw.
 *   - IO error: filePath pointing at a directory → TraceReadError (kind io_error).
 *   - truncation: maxBytes caps reads at line boundary; truncated=true.
 *   - sort stability: rows without a time key keep their relative order.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlTraceReader,
  MAX_TRACE_BYTES,
  MAX_TRACE_BYTES_FOR_CONTAINS,
  TraceReadError,
} from "../../src/traceserver/index.ts";
import type { TraceRecordType } from "../../src/traceserver/types.ts";
import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
} from "../../src/harness/trace/types.ts";

// -- helpers ------------------------------------------------------------------

interface RowOpts {
  readonly recordType: TraceRecordType;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly ts?: string | undefined;
  readonly status?: "ok" | "error" | undefined;
  readonly durationMs?: number | undefined;
  readonly turnIndex?: number | undefined;
  readonly decision?: TurnDecision | undefined;
  readonly toolName?: string | undefined;
  readonly toolKind?: ToolKind | undefined;
  readonly supplierStop?: SupplierStop | undefined;
  readonly stream?: boolean | undefined;
  readonly conversationId?: string | undefined;
  readonly skipStartedAt?: boolean;
  readonly skipTs?: boolean;
}

// TraceRecordType is imported from src/traceserver/types.ts. The other three
// unions are declared inline inside the record interfaces of
// src/harness/trace/types.ts (no exported named union), so we extract them
// from those interfaces rather than duplicating the literals.
type TurnDecision = TurnRecord["decision"];
type ToolKind = ToolCallRecord["toolKind"];
type SupplierStop = NonNullable<LlmCallRecord["supplierStop"]>;

/** Build a JSONL row that mirrors the snake_case wire format. */
function makeLine(opts: RowOpts): string {
  const obj: Record<string, unknown> = {};
  if (opts.conversationId !== undefined)
    obj["conversation_id"] = opts.conversationId;
  obj["record_type"] = opts.recordType;
  if (opts.recordType !== "violation") {
    const idField = `${opts.recordType}_id` as const;
    obj[idField] =
      `id-${opts.recordType}-${Math.random().toString(36).slice(2, 10)}`;
  }
  if (
    opts.startedAt !== undefined ||
    (!opts.skipStartedAt && opts.recordType !== "violation")
  ) {
    obj["started_at"] = opts.startedAt ?? "2026-08-01T00:00:00.000Z";
  }
  if (opts.endedAt !== undefined) obj["ended_at"] = opts.endedAt;
  if (opts.durationMs !== undefined) obj["duration_ms"] = opts.durationMs;
  if (opts.status !== undefined) obj["status"] = opts.status;
  if (opts.turnIndex !== undefined) obj["turn_index"] = opts.turnIndex;
  if (opts.decision !== undefined) obj["decision"] = opts.decision;
  if (opts.toolName !== undefined) obj["tool_name"] = opts.toolName;
  if (opts.toolKind !== undefined) obj["tool_kind"] = opts.toolKind;
  if (opts.supplierStop !== undefined) obj["supplier_stop"] = opts.supplierStop;
  if (opts.stream !== undefined) obj["stream"] = opts.stream;
  if (opts.ts !== undefined) obj["ts"] = opts.ts;
  else if (opts.recordType === "violation" && !opts.skipTs)
    obj["ts"] = "2026-08-01T00:00:00.000Z";
  return JSON.stringify(obj);
}

let tmpDir: string;
let tracePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-reader-"));
  tracePath = join(tmpDir, "trace.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- happy path ---------------------------------------------------------------

describe("createJsonlTraceReader — happy path", () => {
  it("returns rows in descending time order mixing all four record types", () => {
    const lines = [
      makeLine({
        recordType: "llm_call",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "ok",
        durationMs: 200,
        supplierStop: "success",
        stream: false,
      }),
      makeLine({
        recordType: "tool_call",
        startedAt: "2026-08-01T02:00:00.000Z",
        status: "ok",
        durationMs: 5,
        toolName: "grep",
        toolKind: "ok",
      }),
      makeLine({
        recordType: "turn",
        startedAt: "2026-08-01T03:00:00.000Z",
        status: "ok",
        durationMs: 1234,
        turnIndex: 0,
        decision: "completed",
      }),
      makeLine({ recordType: "violation", ts: "2026-08-01T04:00:00.000Z" }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");

    const reader = createJsonlTraceReader({ filePath: tracePath });
    const result = reader.query();

    assert.equal(result.total, 4);
    assert.equal(result.skippedLines, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.records.length, 4);
    assert.deepEqual(
      result.records.map((r) => r["record_type"]),
      ["violation", "turn", "tool_call", "llm_call"]
    );
    assert.equal(result.records[0]?.["ts"], "2026-08-01T04:00:00.000Z");
  });

  it("exposes the documented maxBytes default of 8 MiB", () => {
    assert.equal(MAX_TRACE_BYTES, 8 * 1024 * 1024);
  });
});

// -- filtering ----------------------------------------------------------------

describe("createJsonlTraceReader — filtering", () => {
  it("filters by conversation_id exactly", () => {
    const lines = [
      makeLine({
        recordType: "turn",
        conversationId: "c1",
        startedAt: "2026-08-01T01:00:00.000Z",
        turnIndex: 0,
        decision: "completed",
        status: "ok",
      }),
      makeLine({
        recordType: "turn",
        conversationId: "c2",
        startedAt: "2026-08-01T02:00:00.000Z",
        turnIndex: 0,
        decision: "completed",
        status: "ok",
      }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ conversationId: "c2" });
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["conversation_id"], "c2");
  });

  it("filters by record_type exactly", () => {
    const lines = [
      makeLine({
        recordType: "llm_call",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "ok",
        durationMs: 1,
      }),
      makeLine({
        recordType: "turn",
        startedAt: "2026-08-01T02:00:00.000Z",
        status: "ok",
        durationMs: 1,
        turnIndex: 0,
        decision: "completed",
      }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ recordType: "turn" });
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["record_type"], "turn");
  });

  it("filters by status exactly", () => {
    const lines = [
      makeLine({
        recordType: "llm_call",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "ok",
        durationMs: 1,
      }),
      makeLine({
        recordType: "llm_call",
        startedAt: "2026-08-01T02:00:00.000Z",
        status: "error",
        durationMs: 1,
      }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ status: "error" });
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["status"], "error");
  });

  it("returns zero results when filter excludes everything (total stays 0)", () => {
    const lines = [
      makeLine({
        recordType: "llm_call",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "ok",
        durationMs: 1,
      }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ conversationId: "ghost" });
    assert.equal(out.total, 0);
    assert.equal(out.records.length, 0);
    assert.equal(out.skippedLines, 0);
  });
});

// -- pagination ---------------------------------------------------------------

describe("createJsonlTraceReader — pagination", () => {
  it("applies offset + limit and reports total before slicing", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        makeLine({
          recordType: "llm_call",
          startedAt: `2026-08-01T00:00:0${i}.000Z`,
          status: "ok",
          durationMs: i,
        })
      );
    }
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const page = reader.query({ limit: 3, offset: 2 });
    assert.equal(page.total, 10, "total counts filtered rows, not page");
    assert.equal(page.records.length, 3);
    // descending: row[0]=2026-08-01T00:00:09Z, ..., row[9]=2026-08-01T00:00:00Z.
    // offset=2 skips the two newest; page contains rows 2..4 (in the original
    // 0..9 input), i.e. startedAt 07 / 06 / 05 (in the sorted 0..9 list these
    // are the 3rd..5th rows from the top after removing the 2 newest).
    assert.equal(page.records[0]?.["started_at"], "2026-08-01T00:00:07.000Z");
    assert.equal(page.records[2]?.["started_at"], "2026-08-01T00:00:05.000Z");
  });

  it("returns empty records but reports total when offset exceeds total", () => {
    const lines = [
      makeLine({
        recordType: "turn",
        startedAt: "2026-08-01T01:00:00.000Z",
        status: "ok",
        durationMs: 1,
        turnIndex: 0,
        decision: "completed",
      }),
    ];
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ offset: 99 });
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 0);
  });
});

// -- corrupt lines ------------------------------------------------------------

describe("createJsonlTraceReader — corrupt lines", () => {
  it("counts invalid JSON as skipped", () => {
    const valid = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T01:00:00.000Z",
      status: "ok",
      durationMs: 1,
      turnIndex: 0,
      decision: "completed",
    });
    writeFileSync(
      tracePath,
      [valid, "{not-json", valid].join("\n") + "\n",
      "utf8"
    );
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.equal(out.total, 2);
    assert.equal(out.skippedLines, 1);
  });

  it("counts JSON scalars (number / string) and arrays as skipped", () => {
    const valid = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T01:00:00.000Z",
      status: "ok",
      durationMs: 1,
      turnIndex: 0,
      decision: "completed",
    });
    writeFileSync(
      tracePath,
      [valid, '"42"', '"[1,2]"', "null", "true", valid].join("\n") + "\n",
      "utf8"
    );
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.equal(out.total, 2);
    assert.equal(out.skippedLines, 4);
  });
});

// -- empty file / missing file ------------------------------------------------

describe("createJsonlTraceReader — empty + missing file", () => {
  it("returns an empty result for an empty file (no skip, no throw)", () => {
    writeFileSync(tracePath, "", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.deepEqual(out.records, []);
    assert.equal(out.total, 0);
    assert.equal(out.skippedLines, 0);
    assert.equal(out.truncated, false);
  });

  it("returns an empty result when file does not exist (ENOENT → no throw)", () => {
    const reader = createJsonlTraceReader({
      filePath: join(tmpDir, "absent.jsonl"),
    });
    const out = reader.query();
    assert.deepEqual(out.records, []);
    assert.equal(out.total, 0);
    assert.equal(out.skippedLines, 0);
    assert.equal(out.truncated, false);
  });
});

// -- IO error -----------------------------------------------------------------

describe("createJsonlTraceReader — IO error", () => {
  it("throws TraceReadError (kind io_error) when filePath points at a directory", () => {
    mkdirSync(tracePath);
    const reader = createJsonlTraceReader({ filePath: tracePath });
    assert.throws(
      () => reader.query(),
      (err: unknown) =>
        err instanceof TraceReadError &&
        (err as { kind?: string }).kind === "io_error"
    );
  });
});

// -- truncation ---------------------------------------------------------------

describe("createJsonlTraceReader — truncation", () => {
  it("caps reads at maxBytes, marks truncated=true, and drops the partial last line", () => {
    const lineA = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T01:00:00.000Z",
      status: "ok",
      durationMs: 1,
      turnIndex: 0,
      decision: "completed",
    });
    const lineB = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T02:00:00.000Z",
      status: "ok",
      durationMs: 2,
      turnIndex: 1,
      decision: "completed",
    });
    const all = lineA + "\n" + lineB + "\n";
    writeFileSync(tracePath, all, "utf8");
    // Read exactly the first line + '\n' → buffer ends on a newline, all lines
    // complete, truncated=true because stat.size > maxBytes.
    const maxBytes = Buffer.byteLength(lineA) + 1;
    const reader = createJsonlTraceReader({ filePath: tracePath, maxBytes });
    const out = reader.query();
    assert.equal(out.truncated, true);
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["turn_index"], 0);
  });

  it("drops an incomplete trailing line when maxBytes ends mid-line", () => {
    const lineA = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T01:00:00.000Z",
      status: "ok",
      durationMs: 1,
      turnIndex: 0,
      decision: "completed",
    });
    const lineB = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T02:00:00.000Z",
      status: "ok",
      durationMs: 2,
      turnIndex: 1,
      decision: "completed",
    });
    const all = lineA + "\n" + lineB + "\n";
    writeFileSync(tracePath, all, "utf8");
    // Read lineA + '\n' + half of lineB → buffer ends mid-line → second line
    // is dropped to preserve line-boundary truncation.
    const maxBytes =
      Buffer.byteLength(lineA) + 1 + Math.floor(Buffer.byteLength(lineB) / 2);
    const reader = createJsonlTraceReader({ filePath: tracePath, maxBytes });
    const out = reader.query();
    assert.equal(out.truncated, true);
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["turn_index"], 0);
  });
});

// -- sort stability -----------------------------------------------------------

describe("createJsonlTraceReader — sort stability for time-less rows", () => {
  it("preserves relative order of rows without started_at / ts after rows with a timestamp", () => {
    const withTs = makeLine({
      recordType: "violation",
      ts: "2026-08-01T05:00:00.000Z",
    });
    const lineA =
      '{"record_type":"turn","turn_index":1,"conversation_id":"c1"}';
    const lineB =
      '{"record_type":"turn","turn_index":2,"conversation_id":"c1"}';
    // Write order: withTs, lineA, lineB. Expected order: withTs first (newest),
    // then lineA, then lineB (stable, both lack started_at).
    writeFileSync(tracePath, [withTs, lineA, lineB].join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.equal(out.total, 3);
    assert.equal(out.records[0]?.["record_type"], "violation");
    assert.equal(out.records[1]?.["turn_index"], 1);
    assert.equal(out.records[2]?.["turn_index"], 2);
  });
});

// -- contains (trace-mcp-args-search task) -------------------------------------

describe("createJsonlTraceReader — contains filter", () => {
  it("matches llm_call rows by a substring of their serialized messages", () => {
    const hit = JSON.stringify({
      record_type: "llm_call",
      llm_call_id: "llm-1",
      started_at: "2026-08-01T01:00:00.000Z",
      status: "ok",
      messages: [{ role: "user", content: "read .iknow/skills/design-taste" }],
    });
    const miss = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T02:00:00.000Z",
      turnIndex: 0,
      decision: "completed",
      status: "ok",
    });
    writeFileSync(tracePath, [hit, miss].join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ contains: ".iknow/skills" });
    assert.equal(out.total, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]?.["llm_call_id"], "llm-1");
  });

  it("is case-sensitive", () => {
    const hit = JSON.stringify({
      record_type: "tool_call",
      tool_call_id: "tool-1",
      started_at: "2026-08-01T01:00:00.000Z",
      status: "ok",
      arguments: { path: ".IKNOW/skills" },
    });
    writeFileSync(tracePath, hit + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    assert.equal(reader.query({ contains: ".iknow/skills" }).total, 0);
    assert.equal(reader.query({ contains: ".IKNOW/skills" }).total, 1);
  });

  it("returns empty rows when nothing matches", () => {
    const line = makeLine({
      recordType: "turn",
      startedAt: "2026-08-01T01:00:00.000Z",
      turnIndex: 0,
      decision: "completed",
      status: "ok",
    });
    writeFileSync(tracePath, line + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ contains: "no-such-substring-anywhere" });
    assert.equal(out.total, 0);
    assert.deepEqual(out.records, []);
  });

  it("combines with record_type as AND", () => {
    // Both lines carry the substring; only the tool_call survives the AND.
    const tool = JSON.stringify({
      record_type: "tool_call",
      tool_call_id: "tool-1",
      started_at: "2026-08-01T01:00:00.000Z",
      status: "ok",
      arguments: { path: ".iknow/skills" },
    });
    const llm = JSON.stringify({
      record_type: "llm_call",
      llm_call_id: "llm-1",
      started_at: "2026-08-01T02:00:00.000Z",
      status: "ok",
      messages: [{ role: "user", content: "list .iknow/skills" }],
    });
    writeFileSync(tracePath, [llm, tool].join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({
      contains: ".iknow/skills",
      recordType: "tool_call",
    });
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["tool_call_id"], "tool-1");
  });

  it("composes with limit/offset pagination (contains is orthogonal to paging)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({
          record_type: "tool_call",
          tool_call_id: `tool-${i}`,
          started_at: `2026-08-01T00:00:0${i}.000Z`,
          status: "ok",
          arguments: { path: `.iknow/skills/item-${i}` },
        })
      );
    }
    writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const page = reader.query({
      contains: ".iknow/skills",
      limit: 2,
      offset: 1,
    });
    // Descending time: tool-4, tool-3, tool-2, tool-1, tool-0; offset 1 skips tool-4.
    assert.equal(page.total, 5);
    assert.deepEqual(
      page.records.map((r) => r["tool_call_id"]),
      ["tool-3", "tool-2"]
    );
  });

  it("hits records past the 8 MiB cap when contains is given (regression: whole-file scan)", () => {
    // The direct regression for the 39MB-trace pain point: a hit beyond the
    // 8 MiB default cap must be reachable via contains. Filler lines pad past
    // MAX_TRACE_BYTES; the target row sits at the file tail.
    const filler = JSON.stringify({
      record_type: "turn",
      turn_id: "pad",
      started_at: "2026-08-01T00:00:00.000Z",
      status: "ok",
      note: "p",
    }).replace('"p"', `"${"p".repeat(4000)}"`);
    const tail = JSON.stringify({
      record_type: "tool_call",
      tool_call_id: "tool-tail",
      started_at: "2026-08-01T09:00:00.000Z",
      status: "ok",
      arguments: { path: ".iknow/skills/tail" },
    });
    const fillerBytes = Buffer.byteLength(filler) + 1;
    const fillCount = Math.ceil((MAX_TRACE_BYTES + 1) / fillerBytes);
    const content =
      new Array<string>(fillCount).fill(filler).join("\n") + "\n" + tail + "\n";
    writeFileSync(tracePath, content, "utf8");
    assert.ok(
      Buffer.byteLength(content) > MAX_TRACE_BYTES,
      "fixture must exceed the 8 MiB cap"
    );

    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ contains: ".iknow/skills/tail" });
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["tool_call_id"], "tool-tail");
    // 不带 contains 的现状查询仍受 8 MiB 帽约束 — 同一 reader 上两臂对照。
    const plain = reader.query({ recordType: "tool_call" });
    assert.equal(plain.total, 0);
    assert.equal(plain.truncated, true);
  });

  it("refuses files above the contains scan cap with a typed error instead of silently truncating", () => {
    const filler = JSON.stringify({
      record_type: "turn",
      turn_id: "pad",
      started_at: "2026-08-01T00:00:00.000Z",
      status: "ok",
      note: "p",
    }).replace('"p"', `"${"p".repeat(2000)}"`);
    const fillerBytes = Buffer.byteLength(filler) + 1;
    const fillCount = Math.ceil((64 * 1024 + 1) / fillerBytes);
    const content = new Array<string>(fillCount).fill(filler).join("\n") + "\n";
    writeFileSync(tracePath, content, "utf8");
    const reader = createJsonlTraceReader({
      filePath: tracePath,
      containsMaxBytes: 64 * 1024,
    });
    assert.throws(
      () => reader.query({ contains: "anything" }),
      (err: unknown) =>
        err instanceof TraceReadError &&
        (err as { kind?: string }).kind === "io_error" &&
        err.message.includes("contains query refused")
    );
  });

  it("documents the contains scan cap constant (256 MiB)", () => {
    assert.equal(MAX_TRACE_BYTES_FOR_CONTAINS, 256 * 1024 * 1024);
  });

  it("leaves byte-level semantics (offset, truncated) untouched when contains filters lines", () => {
    // contains 过滤发生在行边界切分之后, 所以 nextOffset 仍指向最后一条
    // **完整行**的结尾 (含未命中行), truncated 仍由字节帽决定 — 轮询续读
    // 不会因过滤而丢行。
    const filler = JSON.stringify({
      record_type: "turn",
      turn_id: "pad",
      started_at: "2026-08-01T00:00:00.000Z",
      status: "ok",
      note: "p",
    }).replace('"p"', `"${"p".repeat(4000)}"`);
    const tail = JSON.stringify({
      record_type: "tool_call",
      tool_call_id: "tool-tail",
      started_at: "2026-08-01T09:00:00.000Z",
      status: "ok",
      arguments: { path: ".iknow/skills/tail" },
    });
    const fillerBytes = Buffer.byteLength(filler) + 1;
    const fillCount = Math.ceil((MAX_TRACE_BYTES + 1) / fillerBytes);
    const content =
      new Array<string>(fillCount).fill(filler).join("\n") + "\n" + tail + "\n";
    writeFileSync(tracePath, content, "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query({ contains: ".iknow/skills/tail" });
    // contains 走 containsMaxBytes (256 MiB) > 文件大小, 故不截断; offset
    // 指向文件结尾 (tail + "\n" 之后), 即全文件的完整行边界。
    assert.equal(out.truncated, false);
    assert.equal(out.offset, Buffer.byteLength(content));
  });
});
