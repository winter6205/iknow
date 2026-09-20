/**
 * tests/tui/pangu.test.ts — panguSpacing pure-function unit tests (bun:test).
 *
 * Coverage: half-width space insertion at CJK ↔ ASCII alnum boundaries,
 * idempotence, pure-Chinese/pure-English unchanged, empty/whitespace input,
 * en dash not split, no insertion beside full-width punctuation.
 */
import { expect, test } from "bun:test";
import {
  panguSpacing,
  panguSpacingKeepingCodespans,
} from "../../src/tui/pangu.js";

// ── happy path: insert space at CJK ↔ ASCII letter/digit boundaries ───────

test("中文与数字相邻：美股4月 → 美股 4 月", () => {
  expect(panguSpacing("美股4月")).toBe("美股 4 月");
});

test("ASCII 字母与中文相邻：CNBC的页面 → CNBC 的页面", () => {
  expect(panguSpacing("CNBC的页面")).toBe("CNBC 的页面");
});

test("双向边界：价格是100元 → 价格是 100 元", () => {
  expect(panguSpacing("价格是100元")).toBe("价格是 100 元");
});

// ── idempotent: existing spaces are not duplicated ────────────────────────

test("幂等：美股 4 月 保持不变", () => {
  expect(panguSpacing("美股 4 月")).toBe("美股 4 月");
});

test("幂等：重复调用结果不变", () => {
  const once = panguSpacing("美股4月涨幅10%");
  expect(panguSpacing(once)).toBe(once);
});

// ── unchanged input: pure Chinese / pure English / empty ──────────────────

test("纯中文不变", () => {
  expect(panguSpacing("今天天气很好")).toBe("今天天气很好");
});

test("纯英文不变", () => {
  expect(panguSpacing("hello world 123")).toBe("hello world 123");
});

test("空串原样返回", () => {
  expect(panguSpacing("")).toBe("");
});

test("纯空白原样返回", () => {
  expect(panguSpacing("   \t\n ")).toBe("   \t\n ");
});

// ── boundary: en dash not split, insert only at CJK edges ─────────────────

test("en dash 范围不拆：4–6月 → 4–6 月", () => {
  expect(panguSpacing("4–6月")).toBe("4–6 月");
});

// ── no space insertion beside full-width punctuation ───────────────────────

test("全角标点（。，、「」）旁不插空格", () => {
  expect(panguSpacing("结束。好的、很好「测试」，就这样")).toBe(
    "结束。好的、很好「测试」，就这样"
  );
});

test("标点与 ASCII 混合：只在 CJK 边界插", () => {
  expect(panguSpacing("价格是100。")).toBe("价格是 100。");
});

// ── CJK char-class coverage: Ext-A / compatibility ideographs / 〇; full-width alnum excluded ──

test("〇（U+3007）参与边界插空格", () => {
  expect(panguSpacing("公元〇年abc")).toBe("公元〇年 abc");
});

test("扩展 A 汉字（㐀）参与边界插空格", () => {
  expect(panguSpacing("㐀test")).toBe("㐀 test");
});

test("全角字母数字（ＡＢＣ１２３）不视为 ASCII，不插空格", () => {
  expect(panguSpacing("美股１２３月")).toBe("美股１２３月");
});

// ── codespan protection: blockquote raw lines only (inline `...` spans untouched) ──

test("codespan 保护：codespan 内不插，外围照常插", () => {
  expect(panguSpacingKeepingCodespans("涨幅10元 `中a文123` 尾注2行")).toBe(
    "涨幅 10 元 `中a文123` 尾注 2 行"
  );
});

test("codespan 保护：多个 codespan 各自保护", () => {
  expect(panguSpacingKeepingCodespans("价1元 `a中b` 和2个 `c文d` 尾3注")).toBe(
    "价 1 元 `a中b` 和 2 个 `c文d` 尾 3 注"
  );
});

test("codespan 保护：未闭合反引号按普通文本插空格", () => {
  expect(panguSpacingKeepingCodespans("涨幅10元 `未闭合")).toBe(
    "涨幅 10 元 `未闭合"
  );
});

test("codespan 保护：空 codespan 与无 codespan 输入", () => {
  expect(panguSpacingKeepingCodespans("前后 `` 中间1处")).toBe(
    "前后 `` 中间 1 处"
  );
  expect(panguSpacingKeepingCodespans("美股4月")).toBe("美股 4 月");
  expect(panguSpacingKeepingCodespans("")).toBe("");
});
