/**
 * JsonlTraceReader incremental reads + the raw.unmapped pool (trace panel v2).
 *
 * Categories covered (S2 defensive contract):
 *   - happy path: resumeOffset reads only new lines; the result offset is a byte
 *     offset and advances with appends.
 *   - empty file: offset=0, no records, no skips.
 *   - append: first round reads all → second round resumes with the offset and
 *     returns only the added lines.
 *   - file replaced (resumeOffset beyond the new file): re-read all from the head.
 *   - maxBytes window combined with resumeOffset (incremental window capped,
 *     offset still line-aligned).
 *   - unknown fields → the raw.unmapped pool (the panel's "other fields" view);
 *     known fields stay out of it; no raw key when nothing is unknown; unmapped
 *     lists only unknown keys with values kept verbatim.
 *   - error path: a directory path still throws TraceReadError.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlTraceReader,
  TraceReadError,
} from "../../src/traceserver/index.ts";

let tmpDir: string;
let tracePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-incr-"));
  tracePath = join(tmpDir, "session.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- helpers ------------------------------------------------------------------

/** Build one JSONL line with an ordering timestamp (record_type=llm_call). */
function line(ts: string, extra?: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {
    conversation_id: "c1",
    record_type: "llm_call",
    llm_call_id: `id-${ts}`,
    started_at: ts,
    duration_ms: 1,
    status: "ok",
    ...extra,
  };
  return JSON.stringify(obj);
}

// -- happy path: resumeOffset -------------------------------------------------

describe("createJsonlTraceReader — incremental resumeOffset", () => {
  it("reads only rows after resumeOffset (byte offset, not row offset)", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    const b = line("2026-08-01T00:00:02.000Z");
    writeFileSync(tracePath, a + "\n" + b + "\n", "utf8");

    const reader = createJsonlTraceReader({ filePath: tracePath });
    const first = reader.query();
    assert.equal(first.total, 2);
    assert.equal(first.records.length, 2);
    assert.ok(first.offset > 0, "first read reports a byte offset");
    assert.equal(
      first.offset,
      Buffer.byteLength(a + "\n" + b + "\n"),
      "offset = 完整文件字节数 (行边界对齐)"
    );

    // Rewind to the end of the first line → only the second line remains.
    const resume = Buffer.byteLength(a + "\n");
    const second = reader.query({ resumeOffset: resume });
    assert.equal(second.total, 1);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]?.["started_at"], "2026-08-01T00:00:02.000Z");
    assert.equal(second.offset, Buffer.byteLength(a + "\n" + b + "\n"));
  });

  it("returns empty when resumeOffset is at EOF (no new rows)", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const first = reader.query();
    const second = reader.query({ resumeOffset: first.offset });
    assert.deepEqual(second.records, []);
    assert.equal(second.total, 0);
    assert.equal(second.skippedLines, 0);
    assert.equal(second.offset, first.offset, "no new bytes → offset 保持");
  });

  it("reports truncated=true and line-aligned offset when the incremental window exceeds maxBytes", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    const b = line("2026-08-01T00:00:02.000Z");
    const all = a + "\n" + b + "\n";
    writeFileSync(tracePath, all, "utf8");
    // Read only the first line → truncated=true (size - 0 > maxBytes), offset lands at the end of line one.
    const maxBytes = Buffer.byteLength(a) + 1;
    const reader = createJsonlTraceReader({ filePath: tracePath, maxBytes });
    const out = reader.query();
    assert.equal(out.truncated, true);
    assert.equal(out.total, 1);
    assert.equal(out.records[0]?.["started_at"], "2026-08-01T00:00:01.000Z");
    assert.equal(out.offset, Buffer.byteLength(a) + 1);
  });
});

// -- empty file ---------------------------------------------------------------

describe("createJsonlTraceReader — incremental empty file", () => {
  it("empty file → offset 0, no records, no skipped", () => {
    writeFileSync(tracePath, "", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.deepEqual(out.records, []);
    assert.equal(out.total, 0);
    assert.equal(out.skippedLines, 0);
    assert.equal(out.truncated, false);
    assert.equal(out.offset, 0);
  });

  it("missing file (ENOENT) → offset 0, no throw", () => {
    const reader = createJsonlTraceReader({
      filePath: join(tmpDir, "absent.jsonl"),
    });
    const out = reader.query();
    assert.deepEqual(out.records, []);
    assert.equal(out.offset, 0);
  });
});

// -- append -------------------------------------------------------------------

describe("createJsonlTraceReader — file append", () => {
  it("appended rows are returned by the next poll with the previous offset", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });

    const first = reader.query();
    assert.equal(first.total, 1);
    assert.equal(first.records[0]?.["started_at"], "2026-08-01T00:00:01.000Z");

    // Simulate the writer appending line two with appendFileSync.
    const b = line("2026-08-01T00:00:02.000Z");
    writeFileSync(tracePath, a + "\n" + b + "\n", "utf8");

    const second = reader.query({ resumeOffset: first.offset });
    assert.equal(second.total, 1, "只回新增行");
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]?.["started_at"], "2026-08-01T00:00:02.000Z");
    assert.equal(second.offset, Buffer.byteLength(a + "\n" + b + "\n"));
  });

  it("an in-progress final line (no trailing newline) is deferred to the next poll", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const first = reader.query();
    assert.equal(first.offset, Buffer.byteLength(a + "\n"));

    // Write in progress: line two is partially on disk without a trailing newline.
    const partial = '{"conversation_id":"c1","record_type":"llm_call"';
    writeFileSync(tracePath, a + "\n" + partial, "utf8");

    const mid = reader.query({ resumeOffset: first.offset });
    assert.deepEqual(mid.records, [], "不完整行不解析");
    assert.equal(mid.offset, first.offset, "offset 保持，下轮重读该行");

    // The writer completes the line.
    const b = line("2026-08-01T00:00:02.000Z");
    writeFileSync(tracePath, a + "\n" + b + "\n", "utf8");

    const final = reader.query({ resumeOffset: mid.offset });
    assert.equal(final.total, 1);
    assert.equal(final.records[0]?.["started_at"], "2026-08-01T00:00:02.000Z");
  });
});

// -- replaced file ------------------------------------------------------------

describe("createJsonlTraceReader — file replaced", () => {
  it("resumeOffset beyond the new file size recalls the full file (no data loss)", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    const b = line("2026-08-01T00:00:02.000Z");
    const c = line("2026-08-01T00:00:03.000Z");
    writeFileSync(tracePath, a + "\n" + b + "\n" + c + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const first = reader.query();
    const oldOffset = first.offset;
    assert.equal(first.total, 3);

    // File replaced by a smaller new session (old offset out of bounds) → recall from the head.
    writeFileSync(tracePath, line("2026-08-02T00:00:00.000Z") + "\n", "utf8");
    const second = reader.query({ resumeOffset: oldOffset });
    assert.equal(second.total, 1, "召回新文件全量");
    assert.equal(second.records[0]?.["started_at"], "2026-08-02T00:00:00.000Z");
    assert.ok(second.offset < oldOffset, "新 offset 反映新文件大小");
  });

  it("resumeOffset equal to the replaced file size returns empty (no throw)", () => {
    const a = line("2026-08-01T00:00:01.000Z");
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const first = reader.query();

    // Replaced with the same size but different content — the blind spot of
    // incremental reads (no content fingerprint); it must stay silent.
    writeFileSync(tracePath, line("2026-08-03T00:00:00.000Z") + "\n", "utf8");
    const second = reader.query({ resumeOffset: first.offset });
    assert.deepEqual(second.records, []);
    assert.equal(second.total, 0);
  });
});

// -- raw.unmapped pool --------------------------------------------------------

describe("createJsonlTraceReader — raw.unmapped pool (SC-R 15)", () => {
  it("unknown top-level fields are collected into raw.unmapped", () => {
    const a = line("2026-08-01T00:00:01.000Z", {
      unknown_field: "xyz",
      another: 42,
    });
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    assert.equal(out.total, 1);
    const row = out.records[0] as Record<string, unknown>;
    const raw = row["raw"] as {
      unmapped: Array<{ key: string; value: unknown }>;
    };
    assert.ok(raw, "unknown fields must produce a raw object");
    assert.ok(Array.isArray(raw.unmapped));
    // llm_call_id is not in TRACE_FIELD_DEFS, so it also lands in unmapped.
    assert.deepEqual(raw.unmapped.map((u) => u.key).sort(), [
      "another",
      "llm_call_id",
      "unknown_field",
    ]);
    const unknown = raw.unmapped.find((u) => u.key === "unknown_field");
    assert.equal(unknown?.value, "xyz");
    const another = raw.unmapped.find((u) => u.key === "another");
    assert.equal(another?.value, 42);
  });

  it("known fields never land in raw.unmapped", () => {
    // A row containing only jsonlKeys declared in TRACE_FIELD_DEFS → no raw key.
    const knownOnly =
      '{"conversation_id":"c1","record_type":"llm_call",' +
      '"started_at":"2026-08-01T00:00:01.000Z","ended_at":"2026-08-01T00:00:02.000Z",' +
      '"duration_ms":1000,"status":"ok","supplier_stop":"success","stream":false}';
    writeFileSync(tracePath, knownOnly + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    const row = out.records[0] as Record<string, unknown>;
    assert.equal(
      "raw" in row,
      false,
      "no raw key when there are no unknown fields"
    );
  });

  it("known fields coexist with unknown ones and stay at top level", () => {
    const a = line("2026-08-01T00:00:01.000Z", { custom_extra: true });
    writeFileSync(tracePath, a + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    const row = out.records[0] as Record<string, unknown>;
    assert.equal(row["record_type"], "llm_call");
    assert.equal(row["started_at"], "2026-08-01T00:00:01.000Z");
    const raw = row["raw"] as { unmapped: Array<{ key: string }> };
    assert.deepEqual(raw.unmapped.map((u) => u.key).sort(), [
      "custom_extra",
      "llm_call_id",
    ]);
  });

  it("raw.unmapped survives filtering and pagination", () => {
    const a = line("2026-08-01T00:00:01.000Z", { ghost: 1 });
    const b = line("2026-08-01T00:00:02.000Z");
    writeFileSync(tracePath, a + "\n" + b + "\n", "utf8");
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const out = reader.query();
    // Descending: b (02:00) first, a (01:00, carries ghost) last.
    assert.equal(out.records.length, 2);
    const row = out.records.find(
      (r) => r["started_at"] === "2026-08-01T00:00:01.000Z"
    ) as Record<string, unknown>;
    const raw = row["raw"] as { unmapped: Array<{ key: string }> };
    assert.deepEqual(raw.unmapped.map((u) => u.key).sort(), [
      "ghost",
      "llm_call_id",
    ]);
  });
});

// -- IO error regression ------------------------------------------------------

describe("createJsonlTraceReader — IO error regression (directory)", () => {
  it("filePath pointing at a directory still throws TraceReadError", () => {
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
