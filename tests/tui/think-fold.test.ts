/**
 * tests/tui/think-fold.test.ts
 *
 * thinking 折叠行 / 流式行文案纯函数单测（think-fold.ts）。
 *
 * 2026-08-14 修复（两套文案渲染不统一）：
 *  - chat-view.tsx 流式折叠行旧文案 = `[思考] 思考中… N 秒` / `[思考] 思考了 N 秒`
 *    （秒数叠加在 [思考] 标记上）；
 *  - message-blocks.tsx 历史折叠行旧文案 = `思考了 N 秒` / 纯 `[思考]`
 *    （秒数替换 [思考] 标记）。
 * 本模块把两处收敛到同一纯函数，从源头统一：`思考了 N 秒` 本身即带语义，
 * 不再叠加 `[思考]` 前缀；子秒 / 无秒数 / 非有限 → 空串（不换括号标签，
 * 也不造「思考了 0 秒」）。
 * 流式行不再叠加实时秒数（恒 `思考中…`）—— 思考时长由事后 frozen 摘要
 * `思考了 N 秒` 承担，避免与 mode 行运行时长视觉重复 + 语义混淆。
 */
import { describe, expect, test } from "bun:test";
import {
  THINKING_PEEK_MAX_LINES,
  formatThinkingFold,
  formatThinkingLive,
  pinThinkingSeconds,
  thinkingPeekLines,
} from "../../src/tui/think-fold.js";

describe("formatThinkingFold（历史折叠行文案）", () => {
  test("seconds > 0 → `思考了 N 秒`（不叠加 [思考] 前缀）", () => {
    expect(formatThinkingFold(7)).toBe("思考了 7 秒");
    expect(formatThinkingFold(1)).toBe("思考了 1 秒");
  });

  test("empty：0 / undefined → 空串（不换 [思考]、不造 0 秒）", () => {
    expect(formatThinkingFold(0)).toBe("");
    expect(formatThinkingFold(undefined)).toBe("");
  });

  test("negative：负值 → 空串", () => {
    expect(formatThinkingFold(-1)).toBe("");
  });

  test("overflow：超大秒数仍格式化，不抛", () => {
    expect(formatThinkingFold(1e9)).toBe("思考了 1000000000 秒");
  });

  test("concurrent：同一输入重复调用结果稳定（纯函数）", () => {
    expect(formatThinkingFold(3)).toBe(formatThinkingFold(3));
    expect(formatThinkingFold(0)).toBe(formatThinkingFold(0));
  });

  test("exception：NaN / Infinity → 空串（非有限不当成秒数）", () => {
    expect(formatThinkingFold(Number.NaN)).toBe("");
    expect(formatThinkingFold(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatThinkingFold(Number.NEGATIVE_INFINITY)).toBe("");
  });
});

describe("pinThinkingSeconds（思考结束钉秒，供结束态唯一文案）", () => {
  test("empty：无 thinking 正文 → 0（本来没思考，不造秒数）", () => {
    expect(pinThinkingSeconds(0, 0, 9)).toBe(0);
  });

  test("negative：已冻结不覆盖；负 elapsed 且有正文 → 至少 1", () => {
    expect(pinThinkingSeconds(4, 10, 9)).toBe(4);
    expect(pinThinkingSeconds(0, 3, -2)).toBe(1);
  });

  test("overflow：有正文 → floor 秒数", () => {
    expect(pinThinkingSeconds(0, 3, 6.9)).toBe(6);
  });

  test("concurrent：同一输入重复钉秒结果稳定", () => {
    expect(pinThinkingSeconds(0, 8, 2)).toBe(pinThinkingSeconds(0, 8, 2));
  });

  test("exception：有正文但不足 1 秒 / 非有限 elapsed → 1（思考发生了就要有结束态）", () => {
    expect(pinThinkingSeconds(0, 12, 0.4)).toBe(1);
    expect(pinThinkingSeconds(0, 12, Number.NaN)).toBe(1);
    expect(pinThinkingSeconds(0, 12, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("formatThinkingLive（流式折叠行文案）", () => {
  test("恒为 `思考中…`（实时秒数已下线 — 思考时长由事后 frozen 摘要承担）", () => {
    expect(formatThinkingLive()).toBe("思考中…");
  });
});

describe("thinkingPeekLines（思考中折叠态正文预览）", () => {
  test("上限常量为 3 行", () => {
    expect(THINKING_PEEK_MAX_LINES).toBe(3);
  });

  test("多行正文 → 取末 3 行（更早的行不进预览）", () => {
    const text = "第一行\n第二行\n第三行\n第四行\n第五行";
    expect(thinkingPeekLines(text)).toEqual(["第三行", "第四行", "第五行"]);
  });

  test("行数不足上限 → 全给（1 行 / 2 行）", () => {
    expect(thinkingPeekLines("只有一行")).toEqual(["只有一行"]);
    expect(thinkingPeekLines("甲\n乙")).toEqual(["甲", "乙"]);
  });

  test("空串 / 纯空白 → 空数组（不占行、不渲染空行）", () => {
    expect(thinkingPeekLines("")).toEqual([]);
    expect(thinkingPeekLines("   \n\t\n")).toEqual([]);
  });

  test("空行不占预览额度（markdown 段落分隔不吃掉正文行）", () => {
    const text = "甲\n\n乙\n\n\n丙\n\n";
    expect(thinkingPeekLines(text)).toEqual(["甲", "乙", "丙"]);
  });

  test("尾部换行不产生空预览行（流式 delta 常以 \\n 结尾）", () => {
    expect(thinkingPeekLines("末行内容\n")).toEqual(["末行内容"]);
  });

  test("CRLF 与行尾空白被剥掉（宽度预算按可见字符算）", () => {
    expect(thinkingPeekLines("甲\r\n乙  \r\n")).toEqual(["甲", "乙"]);
  });

  test("limit 可自定义，但硬夹在 [0, 3]（渲染层不得越过 3 行高度上限）", () => {
    const text = "一\n二\n三\n四\n五";
    expect(thinkingPeekLines(text, 2)).toEqual(["四", "五"]);
    expect(thinkingPeekLines(text, 99)).toEqual(["三", "四", "五"]);
    expect(thinkingPeekLines(text, 0)).toEqual([]);
    expect(thinkingPeekLines(text, -1)).toEqual([]);
  });

  test("任意输入的返回行数恒 ≤ 3（高度上限是硬合同）", () => {
    const long = Array.from({ length: 200 }, (_, i) => `行-${i}`).join("\n");
    expect(thinkingPeekLines(long).length).toBeLessThanOrEqual(
      THINKING_PEEK_MAX_LINES
    );
    expect(thinkingPeekLines(long)).toEqual(["行-197", "行-198", "行-199"]);
  });
});
