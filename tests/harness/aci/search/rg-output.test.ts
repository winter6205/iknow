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

/**
 * rg 传输层的省略标记（Finding 1 的根因面）。
 *
 * rg 的**触发**按字节、**切片**按 code point，两个单位不同；本工具的口径只有
 * code point（`MAX_MATCH_LINE_COLUMNS`）。预算取 4 倍（UTF-8 单字符最大宽度）
 * 后，未超限的行至多被切到 8000 code point（切点落在字符中间时干脆不切），
 * 超限的行则由权威闸收口 —— 两种情形都必须先把残留标记剥掉，最终形状才由
 * code point 闸唯一决定。这组用例钉住剥取谓词本身：既不漏剥（标记进正文），
 * 也不误剥（正文里真的以标记文本结尾的行）。
 */
describe("stripRgPreviewMarker — rg 省略标记只在确定是 rg 加的时候剥", () => {
  it("预算 = code point 上限 × 4（UTF-8 单字符最大宽度）", () => {
    assert.equal(
      rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS),
      MAX_MATCH_LINE_COLUMNS * 4
    );
    // 严大于上限：等于上限时 rg 会抢在权威闸之前截断非 ASCII 行。
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
    // 实测 15.1.0：触发按字节、切片按 code point，两个单位不同，所以
    // 「有标记」不等于「被切过」—— 这类行 rg 只追加标记、正文原样回传。
    // 标记必须剥掉，否则它会被下游的 code point 闸当成正文再截一次，两条
    // 引擎的正文尾巴就不同了（D6/SC9）。
    const line = "hit" + "漢".repeat(2_700); // 8103 字节 / 2703 cp
    assert.ok(
      Buffer.byteLength(line, "utf8") >=
        rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
    );
    assert.equal(stripRgPreviewMarker(`${line}${RG_PREVIEW_MARKER}`), line);
  });

  it("CRLF：尾随 \\r 计入触发基数（正文 7999 字节 + \\r 恰好达线）", () => {
    // 实测 15.1.0：rg 把 `\r` 算进「行超长」的字节数，却不在正文里回显它。
    // 剥标记时若不把这一个字节补回去，7999 字节的行就会漏剥。
    const head = "x".repeat(rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS) - 1);
    const marked = `${head}${RG_PREVIEW_MARKER}`;
    assert.equal(stripRgPreviewMarker(marked, 1), head);
    // 对照：不补这 1 字节时同一正文差一口气达线 —— 不剥。
    assert.equal(stripRgPreviewMarker(marked), marked);
  });
});

/**
 * rg 解析路径的入口（`parseRgNullLines` / 上下文分列都把内容交给它）。
 *
 * 它比共用展示闸多一件事：洗掉**传输层痕迹**。这些痕迹只在 rg 的输出里存在，
 * 所以清洗不能下移到共用闸 —— 否则 Node 路径会把「正文里真实存在的同类文本」
 * 一起削掉（两条引擎对同一文件给出不同正文）。
 */
describe("truncateRgContent — 先洗传输层痕迹，再过 code point 闸", () => {
  it("尾随 \\r 剥掉（Node 侧 splitLines 已剥，两条引擎不得差一个不可见字符）", () => {
    assert.equal(truncateRgContent("hit crlf\r"), "hit crlf");
  });

  it("CRLF 边界行：7999 字节 / 2000 cp 的正文原样保留（不因漏剥而多截一刀）", () => {
    // 这行 + `\r` 恰好 8000 字节 → rg 加标记；正文 2000 cp 未超权威上限。
    // Node 侧看到同一行原样保留，rg 侧也必须原样保留。
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
 * 二进制提示记录（Finding 2）。
 *
 * rg 的检测窗口是 64 KiB 且同一文件在不同出法下结论不同（实测 15.1.0：NUL
 * 在 70 KB 处的文件 `-l` 列出、`--count` 略过、`content` 吐 WARNING）。提示行
 * 与 `path:line:text` 同形，不显式识别就会被解析成假命中；本工具的口径是
 * 「二进制文件不搜」，提示一律丢弃。
 */
describe("isRgBinaryNotice — 二进制提示不是命中行", () => {
  it("识别两种原文（无 NUL 的 `path: ...` 与含 NUL 的 `path\\0 ...`）", () => {
    // 实测 15.1.0 原文：提示行不带 NUL（rg 只在输出内容记录时用 NUL 定界）。
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
    // `--null` 定界形态（同一条提示的另一种姿态）。
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
