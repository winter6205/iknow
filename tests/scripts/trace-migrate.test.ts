/**
 * 旧 trace 迁移脚本 tests（spec T4）。
 *
 * 覆盖（S2 defensive contract）：
 *   - 单文件 → 多文件（按 conversation_id 分文件）。
 *   - 按 conversation_id 分文件（同一会话多行聚到一个文件）。
 *   - 保留原行（逐行原样，不 re-serialize）。
 *   - 坏行处理（JSON 解析失败 / 标量 / 数组 / null / 无 conversation_id 跳过 + 计入报告）。
 *   - 空文件 / 输入不存在 → 空结果不抛错。
 *   - 输出目录不存在时自动创建。
 *   - 报告计数（sessions / totalLines / skippedLines / conversationIds）。
 *   - 删除旧输入：干净迁移后 unlink 旧单文件（CLI fail-fast 不残留触发）；
 *     有坏行 / 输入不存在 / 空输入时不删除。
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateTraceFile } from "../../scripts/trace-migrate.ts";

let tmpDir: string;
let inputPath: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-migrate-"));
  inputPath = join(tmpDir, "trace.jsonl");
  outputDir = join(tmpDir, "trace");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造一条带 conversation_id 的 JSONL 行（内容可含任意字段）。 */
function makeLine(convId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ conversation_id: convId, ...extra });
}

// -- 单文件 → 多文件 -----------------------------------------------------------

describe("migrateTraceFile — 单文件 → 多文件", () => {
  it("split by conversation_id into per-session files", () => {
    writeFileSync(
      inputPath,
      [
        makeLine("c1", { record_type: "turn", turn_index: 0 }),
        makeLine("c2", { record_type: "turn", turn_index: 0 }),
        makeLine("c1", { record_type: "turn", turn_index: 1 }),
      ].join("\n") + "\n",
      "utf8"
    );

    const report = migrateTraceFile(inputPath, outputDir);

    assert.equal(report.sessions, 2);
    assert.equal(report.totalLines, 3);
    assert.equal(report.skippedLines, 0);
    assert.deepEqual(report.conversationIds, ["c1", "c2"]);

    const files = readdirSync(outputDir).sort();
    assert.deepEqual(files, ["c1.jsonl", "c2.jsonl"]);

    const c1 = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    const c2 = readFileSync(join(outputDir, "c2.jsonl"), "utf8");
    assert.equal(c1.split("\n").filter((l) => l.length > 0).length, 2);
    assert.equal(c2.split("\n").filter((l) => l.length > 0).length, 1);
  });

  it("creates the output directory when it does not exist", () => {
    writeFileSync(inputPath, makeLine("c1") + "\n", "utf8");
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.sessions, 1);
    assert.ok(readdirSync(outputDir).includes("c1.jsonl"));
  });
});

// -- 保留原行 ------------------------------------------------------------------

describe("migrateTraceFile — 保留原行", () => {
  it("writes the exact original line text without re-serialization", () => {
    // 原始行带有非规范的空格/键序，re-serialize 会改变它；迁移必须原样保留。
    const rawLine =
      '  {  "conversation_id" : "c1" , "record_type" : "turn" , "note" : "keep me" }';
    // 注意：JSON.stringify 会压平空格，这里手动拼一个带多余空格的合法 JSON。
    const spaced = '{"conversation_id":"c1",   "note":"spacing kept"}';
    // 用带前导空格的原始文本（合法 JSONL 允许行首空白）。
    const leading = '   {"conversation_id":"c1","note":"leading space"}';
    writeFileSync(
      inputPath,
      [rawLine, spaced, leading].join("\n") + "\n",
      "utf8"
    );

    migrateTraceFile(inputPath, outputDir);

    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    const outLines = out.split("\n").filter((l) => l.length > 0);
    // 逐行与输入完全一致（含前导空格），证明未 re-serialize。
    assert.equal(outLines[0], rawLine);
    assert.equal(outLines[1], spaced);
    assert.equal(outLines[2], leading);
  });

  it("preserves a trailing line without a final newline", () => {
    const line = makeLine("c1", { turn_index: 0 });
    writeFileSync(inputPath, line, "utf8"); // 无末尾换行
    migrateTraceFile(inputPath, outputDir);
    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    assert.equal(out, line + "\n");
  });
});

// -- 坏行处理 ------------------------------------------------------------------

describe("migrateTraceFile — 坏行处理", () => {
  it("skips invalid JSON and counts it in the report", () => {
    writeFileSync(
      inputPath,
      [makeLine("c1"), "{not-json", makeLine("c1")].join("\n") + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.totalLines, 3);
    assert.equal(report.skippedLines, 1);
    assert.equal(report.sessions, 1);
    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    assert.equal(out.split("\n").filter((l) => l.length > 0).length, 2);
  });

  it("skips JSON scalars / arrays / null as bad lines", () => {
    writeFileSync(
      inputPath,
      [makeLine("c1"), '"42"', '"[1,2]"', "null", "true", makeLine("c1")].join(
        "\n"
      ) + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.totalLines, 6);
    assert.equal(report.skippedLines, 4);
    assert.equal(report.sessions, 1);
  });

  it("skips a valid object missing conversation_id", () => {
    writeFileSync(
      inputPath,
      [
        makeLine("c1"),
        '{"record_type":"violation","ts":"x"}',
        makeLine("c1"),
      ].join("\n") + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.totalLines, 3);
    assert.equal(report.skippedLines, 1);
    assert.equal(report.conversationIds.length, 1);
  });

  it("skips a non-string conversation_id", () => {
    writeFileSync(
      inputPath,
      [makeLine("c1"), '{"conversation_id":123}', makeLine("c1")].join("\n") +
        "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.totalLines, 3);
    assert.equal(report.skippedLines, 1);
  });
});

// -- 空 / 缺失输入 --------------------------------------------------------------

describe("migrateTraceFile — 空 / 缺失输入", () => {
  it("returns an empty report for an empty file (no throw)", () => {
    writeFileSync(inputPath, "", "utf8");
    const report = migrateTraceFile(inputPath, outputDir);
    assert.deepEqual(report, {
      sessions: 0,
      totalLines: 0,
      skippedLines: 0,
      conversationIds: [],
      removedInput: true,
    });
  });

  it("returns an empty report when input does not exist (ENOENT → no throw)", () => {
    const report = migrateTraceFile(join(tmpDir, "absent.jsonl"), outputDir);
    assert.deepEqual(report, {
      sessions: 0,
      totalLines: 0,
      skippedLines: 0,
      conversationIds: [],
      removedInput: false,
    });
  });
});

// -- 报告计数 ------------------------------------------------------------------

describe("migrateTraceFile — 报告计数", () => {
  it("reports per-session counts and conversationIds in first-seen order", () => {
    writeFileSync(
      inputPath,
      [
        makeLine("b", { turn_index: 0 }),
        makeLine("a", { turn_index: 0 }),
        makeLine("b", { turn_index: 1 }),
        makeLine("a", { turn_index: 1 }),
      ].join("\n") + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.sessions, 2);
    assert.equal(report.totalLines, 4);
    assert.equal(report.skippedLines, 0);
    assert.deepEqual(report.conversationIds, ["b", "a"]);
  });
});

// -- 删除旧输入 -----------------------------------------------------------------

describe("migrateTraceFile — 删除旧输入", () => {
  it("deletes the legacy single-file after a clean migration", () => {
    writeFileSync(
      inputPath,
      [makeLine("c1"), makeLine("c2")].join("\n") + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.skippedLines, 0);
    assert.equal(report.removedInput, true);
    assert.equal(existsSync(inputPath), false);
  });

  it("keeps the input when any line is skipped (data may be lost)", () => {
    writeFileSync(
      inputPath,
      [makeLine("c1"), "{bad-json", makeLine("c1")].join("\n") + "\n",
      "utf8"
    );
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.skippedLines, 1);
    assert.equal(report.removedInput, false);
    assert.equal(existsSync(inputPath), true);
    // 迁移结果照常落盘，只是不删输入。
    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    assert.equal(out.split("\n").filter((l) => l.length > 0).length, 2);
  });

  it("does not delete an absent input (removedInput false, no throw)", () => {
    const report = migrateTraceFile(join(tmpDir, "absent.jsonl"), outputDir);
    assert.equal(report.removedInput, false);
    assert.deepEqual(report, {
      sessions: 0,
      totalLines: 0,
      skippedLines: 0,
      conversationIds: [],
      removedInput: false,
    });
  });

  it("deletes an empty input file after a clean (trivial) migration", () => {
    writeFileSync(inputPath, "", "utf8");
    const report = migrateTraceFile(inputPath, outputDir);
    assert.equal(report.sessions, 0);
    assert.equal(report.skippedLines, 0);
    assert.equal(report.removedInput, true);
    assert.equal(existsSync(inputPath), false);
  });
});
