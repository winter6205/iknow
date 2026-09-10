/**
 * tests/tui/think-fold.test.ts
 *
 * thinking 折叠行 / 流式行文案纯函数单测（think-fold.ts）。
 *
 * 人读合同（specs/tui-human-display.md D1/D2 + CONTEXT `live tool line` /
 * `unit fold`）：进行中行恒定英文 `Thinking…`（无实时秒数），结束态行
 * `Thought for <duration>`（无 `[思考]` 前缀、无中文）。秒数缺失 / 非正 /
 * 非有限 → 空串（不回落括号标签，也不造 0 秒行）。
 *
 * 本文件钉住的纯函数是 TUI 唯一文案源；渲染层（chat-view / message-blocks）
 * 只调本模块，禁止另写模板字符串。
 */
import { describe, expect, test } from "bun:test";
import {
  THINKING_PEEK_MAX_LINES,
  formatThinkingFold,
  formatThinkingLive,
  thinkingPeekLines,
} from "../../src/tui/think-fold.js";

describe("formatThinkingFold（历史结束态折叠行文案）", () => {
  test("seconds > 0 → 英文 `Thought for <duration>`（无中文、无 [思考] 前缀）", () => {
    expect(formatThinkingFold(7)).toBe("Thought for 7s");
    expect(formatThinkingFold(1)).toBe("Thought for 1s");
  });

  test("时长格式：60 秒以上按整秒数展示，不造中文单位", () => {
    expect(formatThinkingFold(60)).toBe("Thought for 60s");
    expect(formatThinkingFold(1e9)).toBe("Thought for 1000000000s");
  });

  test("empty：0 / undefined → 空串（不换 [思考]、不造 0 秒）", () => {
    expect(formatThinkingFold(0)).toBe("");
    expect(formatThinkingFold(undefined)).toBe("");
  });

  test("negative：负值 → 空串", () => {
    expect(formatThinkingFold(-1)).toBe("");
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

  test("旧中文文案不再出现（人读合同切换后不得残留）", () => {
    expect(formatThinkingFold(7)).not.toContain("思考");
    expect(formatThinkingFold(7)).not.toContain("秒");
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
  test("恒为英文 `Thinking…`（实时秒数已下线 — 思考时长由事后 frozen 摘要承担）", () => {
    expect(formatThinkingLive()).toBe("Thinking…");
    expect(formatThinkingLive()).not.toContain("思考");
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
