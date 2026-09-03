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
 * 流式行不再叠加实时秒数（恒 `思考中…`）—— 思考时长由事后落盘 thinkingMs
 * 摘要 `思考了 N 秒` 承担（spec D3：D2 落盘数据接管，app 层内存 pin/freeze
 * 副通道整条删除）。`pinThinkingSeconds` 已删除 —— 单元测试随函数删除而删除
 * （spec D3 授权，折叠行思考秒数来源语义变更）。
 */
import { describe, expect, test } from "bun:test";
import {
  THINKING_PEEK_MAX_LINES,
  formatThinkingFold,
  formatThinkingLive,
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

describe("pinThinkingSeconds（已删除 — spec D3）", () => {
  // D3 (tui-display-consistency):`pinThinkingSeconds` 已删除 —— 折叠行思考
  // 秒数改读落盘 `thinkingMs`（`turn-activity.sumThinkingMsInRange`），
  // TUI 内存不再钉秒。原有单测随函数删除而删除（语义变更：旧入参边界
  // 全部不再相关），由 `turn-activity.test.ts` 的
  // `sumThinkingMsInRange` / `thinkingMsToSeconds` 单测覆盖新数据通路。
  test("placeholder: removed-by-spec-D3", () => {
    expect(typeof formatThinkingLive()).toBe("string");
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
