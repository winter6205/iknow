/**
 * Tests for the legacy-trace migration script (S2 defensive contract).
 *
 * Covers:
 *   - single file → many files (split by conversation_id).
 *   - per-conversation files (multiple lines of one session aggregate into one file).
 *   - original lines preserved (line verbatim, no re-serialization).
 *   - bad-line handling (JSON parse failure / scalar / array / null / missing conversation_id → skip + count in report).
 *   - empty file / missing input → empty result, no throw.
 *   - output directory created automatically when absent.
 *   - report counts (sessions / totalLines / skippedLines / conversationIds).
 *   - deleting the legacy input: unlink after a clean migration (so the CLI
 *     fail-fast never trips on leftovers); not deleted when bad lines exist or
 *     the input is absent.
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

/** Build a JSONL line with conversation_id (content may carry any fields). */
function makeLine(convId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ conversation_id: convId, ...extra });
}

// -- single file → many files ---------------------------------------------------

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

// -- original lines preserved ---------------------------------------------------

describe("migrateTraceFile — 保留原行", () => {
  it("writes the exact original line text without re-serialization", () => {
    // The raw line carries non-canonical spacing/key order; re-serializing would change
    // it, so migration must keep it verbatim.
    const rawLine =
      '  {  "conversation_id" : "c1" , "record_type" : "turn" , "note" : "keep me" }';
    // Note: JSON.stringify collapses spacing, so this legal JSON with extra spaces is hand-built.
    const spaced = '{"conversation_id":"c1",   "note":"spacing kept"}';
    // Original text with leading whitespace (legal JSONL allows leading whitespace on a line).
    const leading = '   {"conversation_id":"c1","note":"leading space"}';
    writeFileSync(
      inputPath,
      [rawLine, spaced, leading].join("\n") + "\n",
      "utf8"
    );

    migrateTraceFile(inputPath, outputDir);

    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    const outLines = out.split("\n").filter((l) => l.length > 0);
    // Lines match the input exactly (leading whitespace included), proving no re-serialization happened.
    assert.equal(outLines[0], rawLine);
    assert.equal(outLines[1], spaced);
    assert.equal(outLines[2], leading);
  });

  it("preserves a trailing line without a final newline", () => {
    const line = makeLine("c1", { turn_index: 0 });
    writeFileSync(inputPath, line, "utf8"); // no trailing newline
    migrateTraceFile(inputPath, outputDir);
    const out = readFileSync(join(outputDir, "c1.jsonl"), "utf8");
    assert.equal(out, line + "\n");
  });
});

// -- bad-line handling ----------------------------------------------------------

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

// -- empty / missing input ------------------------------------------------------

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

// -- report counts ---------------------------------------------------------------

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

// -- deleting the legacy input ---------------------------------------------------

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
    // Migration output lands as usual; only the input is kept.
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
