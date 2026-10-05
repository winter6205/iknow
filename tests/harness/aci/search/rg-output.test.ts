/**
 * rg stdout parsing layer unit tests.
 *
 * rg is invoked with `--null` (`path\0line:text\n`) — colons in paths no
 * longer poison column splitting, the input-side precondition for parser
 * column split. This file locks:
 *   - `path\0line:text` slicing: correct even when the path contains `:`.
 *   - content with `:` / empty content / empty lines lose no rows.
 *   - empty stdout → no hits (not one empty hit).
 *   - leading `./` stripped from paths.
 *   - line content truncated at MAX_MATCH_LINE_COLUMNS with a
 *     `...[truncated]` marker (old contract kept).
 *
 * The delimiter is written as the `\u0000` escape, not a raw NUL byte: a raw
 * byte makes git classify this file as binary, killing diff readability and
 * review.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  isRgBinaryNotice,
  parseRgNullCounts,
  parseRgNullLines,
  RG_PREVIEW_MARKER,
  RG_TRUNCATION_MARKER,
  MAX_MATCH_LINE_COLUMNS,
  rgTransportBudgetBytes,
  stripRgPreviewMarker,
  truncateRgContent,
} from "../../../../src/harness/aci/search/rg-output.ts";

/** One `path\0line:text` record (trailing newline, same shape as rg output). */
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
    // No NUL (not emitted per --null) → skip the whole record, never guess.
    assert.deepEqual(parseRgNullLines("a.ts:3:x\n"), []);
    // Non-numeric line number after the NUL → skip.
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
    // After truncation everything is still a complete emoji (no lone surrogate).
    for (const ch of text.replace(RG_TRUNCATION_MARKER, "")) {
      assert.ok(ch === "😀");
    }
  });
});

/**
 * rg's transport-layer omission marker (root-cause surface).
 *
 * rg **triggers** on bytes but **slices** on code points — different units;
 * this tool's measure is code points only (`MAX_MATCH_LINE_COLUMNS`). With a
 * 4x budget (max UTF-8 width per character), rows under the limit are cut at
 * most to 8000 code points (cut points landing mid-character simply aren't
 * cut), and over-limit rows are closed by the authoritative gate — in both
 * cases the residual marker must be stripped first so the final shape is
 * decided solely by the code-point gate. These cases pin the stripping
 * predicate itself: neither under-strip (marker leaking into the body) nor
 * over-strip (bodies that genuinely end with the marker text).
 */
describe("stripRgPreviewMarker — rg 省略标记只在确定是 rg 加的时候剥", () => {
  it("预算 = code point 上限 × 4（UTF-8 单字符最大宽度）", () => {
    assert.equal(
      rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS),
      MAX_MATCH_LINE_COLUMNS * 4
    );
    // Strictly greater than the cap: at equality rg would truncate
    // non-ASCII lines before the authoritative gate gets a chance.
    assert.ok(
      rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS) > MAX_MATCH_LINE_COLUMNS
    );
  });

  it("rg 加了标记（去标记后仍 >= 预算）→ 剥掉", () => {
    const head = "x".repeat(rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS));
    assert.equal(stripRgPreviewMarker(`${head}${RG_PREVIEW_MARKER}`), head);
  });

  it("正文自己以标记文本结尾（字节数 < 预算）→ 不剥", () => {
    const text = `short${RG_PREVIEW_MARKER}`;
    assert.equal(stripRgPreviewMarker(text), text);
  });

  it("不含标记 → 原样", () => {
    assert.equal(stripRgPreviewMarker("plain"), "plain");
  });

  it("标记在、正文却没被切（切割点落在多字节字符中间）→ 仍要剥标记", () => {
    // Measured on 15.0.0: trigger counts bytes, slicing counts code points —
    // different units, so "marker present" ≠ "line was cut". On such lines rg
    // only appends the marker and returns the body untouched. The marker must
    // be stripped, else the downstream code-point gate treats it as body text
    // and truncates again, diverging the two engines' line tails.
    const line = "hit" + "漢".repeat(2_700); // 8103 bytes / 2703 cp
    assert.ok(
      Buffer.byteLength(line, "utf8") >=
        rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
    );
    assert.equal(stripRgPreviewMarker(`${line}${RG_PREVIEW_MARKER}`), line);
  });

  it("CRLF：尾随 \\r 计入触发基数（正文 7999 字节 + \\r 恰好达线）", () => {
    // Measured on 15.0.0: rg counts `\r` toward the "line too long" byte
    // total but never echoes it in the body. Stripping the marker without
    // adding that byte back would under-strip 7999-byte lines.
    const head = "x".repeat(rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS) - 1);
    const marked = `${head}${RG_PREVIEW_MARKER}`;
    assert.equal(stripRgPreviewMarker(marked, 1), head);
    // Control: without that 1 byte the same body just misses the threshold — no strip.
    assert.equal(stripRgPreviewMarker(marked), marked);
  });
});

/**
 * Entry to rg's parse paths (`parseRgNullLines` / context column split both
 * hand content here).
 *
 * It does one thing more than the shared display gate: wash off **transport
 * artifacts**. Those exist only in rg's output, so the cleaning cannot move
 * down to the shared gate — otherwise the Node path would also shave "the
 * same text genuinely present in the body" (two engines, different bodies
 * for one file).
 */
describe("truncateRgContent — 先洗传输层痕迹，再过 code point 闸", () => {
  it("尾随 \\r 剥掉（Node 侧 splitLines 已剥，两条引擎不得差一个不可见字符）", () => {
    assert.equal(truncateRgContent("hit crlf\r"), "hit crlf");
  });

  it("CRLF 边界行：7999 字节 / 2000 cp 的正文原样保留（不因漏剥而多截一刀）", () => {
    // This line + `\r` is exactly 8000 bytes → rg adds the marker; the body's
    // 2000 cp stay under the authoritative cap. Node sees the line kept as
    // is, so the rg side must keep it as is too.
    const line = `€${"😀".repeat(1_999)}`;
    assert.equal(Array.from(line).length, MAX_MATCH_LINE_COLUMNS);
    assert.equal(
      Buffer.byteLength(line, "utf8"),
      rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS) - 1
    );
    assert.equal(truncateRgContent(`${line}${RG_PREVIEW_MARKER}\r`), line);
  });

  it("标记 + 未切（正文超 code point 上限）→ 剥标记后按权威闸收口", () => {
    const line = "hit" + "漢".repeat(2_700);
    const expected = `${Array.from(line)
      .slice(0, MAX_MATCH_LINE_COLUMNS)
      .join("")}${RG_TRUNCATION_MARKER}`;
    assert.equal(truncateRgContent(`${line}${RG_PREVIEW_MARKER}`), expected);
  });
});

/**
 * Binary-notice records.
 *
 * rg's detection window is 64 KiB and the same file gets different verdicts
 * per output mode (measured on 15.0.0: a file with NUL at 70 KB is listed by
 * `-l`, skipped by `--count`, and emits WARNING in content mode). Notice
 * lines share the `path:line:text` shape, so without explicit recognition
 * they parse as fake hits; this tool's stance is "binary files are not
 * searched" — notices are always dropped.
 */
describe("isRgBinaryNotice — 二进制提示不是命中行", () => {
  it("识别两种原文（无 NUL 的 `path: ...` 与含 NUL 的 `path\\0 ...`）", () => {
    // Verbatim from 15.0.0: notice lines carry no NUL (rg delimits with NUL
    // only for content records).
    assert.equal(
      isRgBinaryNotice(
        'bin.ts: binary file matches (found "\\0" byte around offset 8)'
      ),
      true
    );
    assert.equal(
      isRgBinaryNotice(
        'bin.ts: WARNING: stopped searching binary file after match (found "\\0" byte around offset 70008)'
      ),
      true
    );
    // Same notice in its `--null`-delimited guise.
    assert.equal(
      isRgBinaryNotice(
        'bin.ts\u0000binary file matches (found "\\0" byte around offset 8)'
      ),
      true
    );
  });

  it("命中行正文含同样的字也不被误判（自指查询）", () => {
    assert.equal(
      isRgBinaryNotice("a.ts\u00001:hit binary file matches"),
      false
    );
    assert.equal(
      isRgBinaryNotice(
        'a.ts\u00001:binary file matches (found "\\0" byte around offset 8)'
      ),
      false
    );
    assert.equal(isRgBinaryNotice(record("a.ts", "1", "hit")), false);
  });

  it("提示行不进命中表（不是「解析成怪异命中」，是整条丢弃）", () => {
    const stdout = [
      record("a.ts", "1", "hit one"),
      'bin.ts: WARNING: stopped searching binary file after match (found "\\0" byte around offset 70008)',
      record("b.ts", "2", "hit two"),
    ].join("\n");
    assert.deepEqual(parseRgNullLines(stdout), [
      { path: "a.ts", line: 1, text: "hit one" },
      { path: "b.ts", line: 2, text: "hit two" },
    ]);
  });

  it("count 解析同口径丢弃提示（不产生假计数）", () => {
    const stdout = [
      "a.ts\u00003",
      'bin.ts: WARNING: stopped searching binary file after match (found "\\0" byte around offset 9)',
      "b.ts\u00001",
    ].join("\n");
    assert.deepEqual(parseRgNullCounts(stdout), [
      { path: "a.ts", count: 3 },
      { path: "b.ts", count: 1 },
    ]);
  });
});
