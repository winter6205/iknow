/**
 * rg stdout 解析层单测（SC12 职责 3「行解析」；契约 D2/D3）。
 *
 * rg 以 `--null` 调用（`path\0line:text\n`）—— 路径里的冒号不再污染分列，
 * 这是 D3「parser 分列」在输入侧的前提。本文件锁：
 *   - `path\0line:text` 切分：路径含 `:` 仍正确。
 *   - 内容含 `:` / 空内容 / 空行不丢行。
 *   - 空 stdout → 无命中（不是一条空命中）。
 *   - 路径以 `./` 开头时被剥掉。
 *   - 行内容按 MAX_MATCH_LINE_COLUMNS 截断并带 `...[truncated]` 标记（旧契约保持）。
 *
 * 定界符写作 `\u0000` 转义而非裸 NUL 字节：裸字节会让 git 把本文件判成
 * binary，diff 不可读、review 失效。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseRgNullLines,
  RG_TRUNCATION_MARKER,
  MAX_MATCH_LINE_COLUMNS,
} from "../../../../src/harness/aci/search/rg-output.ts";

/** `path\0line:text` 的一条记录（末尾带换行，与 rg 输出同形）。 */
function record(path: string, line: string, text: string): string {
  return `${path}\u0000${line}:${text}\n`;
}

describe("parseRgNullLines — path\\0line:text", () => {
  it("切出 (path, line, text) 三元组", () => {
    const hits = parseRgNullLines(
      record("src/a.ts", "2", "hit one") + record("src/b.ts", "15", "other")
    );

    assert.deepEqual(hits, [
      { path: "src/a.ts", line: 2, text: "hit one" },
      { path: "src/b.ts", line: 15, text: "other" },
    ]);
  });

  it("路径含冒号仍正确（NUL 定界，不靠首个冒号切路径）", () => {
    const hits = parseRgNullLines(record("weird:name.ts", "3", "payload"));

    assert.deepEqual(hits, [
      { path: "weird:name.ts", line: 3, text: "payload" },
    ]);
  });

  it("内容含冒号只切首个冒号", () => {
    const hits = parseRgNullLines(record("a.ts", "1", "key: value: more"));

    assert.deepEqual(hits, [
      { path: "a.ts", line: 1, text: "key: value: more" },
    ]);
  });

  it("空内容的命中行保留（不是空行丢弃）", () => {
    const hits = parseRgNullLines(record("a.ts", "7", ""));

    assert.deepEqual(hits, [{ path: "a.ts", line: 7, text: "" }]);
  });

  it("剥掉 rg 的 './' 前缀", () => {
    const hits = parseRgNullLines(record("./src/a.ts", "1", "x"));

    assert.deepEqual(hits, [{ path: "src/a.ts", line: 1, text: "x" }]);
  });

  it("空 stdout → 无命中", () => {
    assert.deepEqual(parseRgNullLines(""), []);
    assert.deepEqual(parseRgNullLines("\n"), []);
  });

  it("形状损坏的记录被跳过，不静默产生假命中", () => {
    // 无 NUL（未按 --null 输出）→ 跳过整条，不猜。
    assert.deepEqual(parseRgNullLines("a.ts:3:x\n"), []);
    // NUL 后有非数字行号 → 跳过。
    assert.deepEqual(parseRgNullLines("a.ts\u0000bad:x\n"), []);
  });

  it("超长行按 code point 截断并带标记（旧契约保持）", () => {
    const long = "x".repeat(MAX_MATCH_LINE_COLUMNS + 50);
    const hits = parseRgNullLines(record("a.ts", "1", long));

    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.text.endsWith(RG_TRUNCATION_MARKER));
    assert.equal(
      hits[0]!.text.length,
      MAX_MATCH_LINE_COLUMNS + RG_TRUNCATION_MARKER.length
    );
  });

  it("截断不拆 surrogate pair（按 code point）", () => {
    const long = "😀".repeat(MAX_MATCH_LINE_COLUMNS + 10);
    const hits = parseRgNullLines(record("a.ts", "1", long));

    const text = hits[0]!.text;
    assert.ok(!text.includes("�"), "must not emit replacement chars");
    // 截断后仍全是完整 emoji（无孤立 surrogate）。
    for (const ch of text.replace(RG_TRUNCATION_MARKER, "")) {
      assert.ok(ch === "😀");
    }
  });
});
