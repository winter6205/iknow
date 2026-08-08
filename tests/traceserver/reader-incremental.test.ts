/**
 * JsonlTraceReader 增量读取 + raw.unmapped 池测试 (trace panel v2, SC-R 14/15)。
 *
 * Categories covered (S2 defensive contract):
 *   - happy path: resumeOffset 只读新增行；结果 offset 是字节偏移且随追加前进。
 *   - empty file: offset=0、无记录、无 skip。
 *   - 文件追加: 第一轮全读 → 第二轮带 offset 续读只回新增行。
 *   - 文件被替换 (resumeOffset 落在新文件外): 从文件头召回全量。
 *   - maxBytes 截断窗口与 resumeOffset 组合 (增量窗口封顶, offset 仍是行对齐)。
 *   - 未知字段 → raw.unmapped 池 (面板「其他字段」渲染)；已知字段不入池；
 *     无未知字段时不添加 raw 键；unmapped 只列未知键且值原样保留。
 *   - 错误路径: 目录路径仍抛 TraceReadError。
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

/** 构造一条带排序时间的 JSONL 行 (record_type=llm_call)。 */
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

    // 第二轮回溯到第一行结束处 → 只剩第二行。
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
    // 只读第一行 → truncated=true (size - 0 > maxBytes)，offset 落在第一行结尾。
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

    // 模拟写侧 appendFileSync 追加第二行。
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

    // 写入进行中: 第二行已部分落盘但无结尾换行。
    const partial = '{"conversation_id":"c1","record_type":"llm_call"';
    writeFileSync(tracePath, a + "\n" + partial, "utf8");

    const mid = reader.query({ resumeOffset: first.offset });
    assert.deepEqual(mid.records, [], "不完整行不解析");
    assert.equal(mid.offset, first.offset, "offset 保持，下轮重读该行");

    // 写侧完成该行。
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

    // 文件被替换成更小的新会话 (旧 offset 越界) → 从文件头召回。
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

    // 替换成同样大小但不同内容 — 这是增量读取的盲区 (无内容指纹)，应静默。
    writeFileSync(tracePath, line("2026-08-03T00:00:00.000Z") + "\n", "utf8");
    const second = reader.query({ resumeOffset: first.offset });
    assert.deepEqual(second.records, []);
    assert.equal(second.total, 0);
  });
});

// -- raw.unmapped 池 -----------------------------------------------------------

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
    // llm_call_id 不在 TRACE_FIELD_DEFS 里, 按 SC-R 15 也归入 unmapped。
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
    // 只含 TRACE_FIELD_DEFS 已声明 jsonlKey 的行 → 无 raw 键。
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
    // 降序: b (02:00) 在前, a (01:00, 含 ghost) 在后。
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
