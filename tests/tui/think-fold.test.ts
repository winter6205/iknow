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
 * 不再叠加 `[思考]` 前缀；子秒 / 无秒数时回落 `[思考]`（历史）。
 * 流式行不再叠加实时秒数（恒 `思考中…`）—— 思考时长由事后 frozen 摘要
 * `思考了 N 秒` 承担，避免与 mode 行运行时长视觉重复 + 语义混淆。
 */
import { describe, expect, test } from "bun:test";
import {
  formatThinkingFold,
  formatThinkingLive,
} from "../../src/tui/think-fold.js";

describe("formatThinkingFold（历史折叠行文案）", () => {
  test("seconds > 0 → `思考了 N 秒`（替换 [思考]，不叠加前缀）", () => {
    expect(formatThinkingFold(7)).toBe("思考了 7 秒");
    expect(formatThinkingFold(1)).toBe("思考了 1 秒");
  });

  test("seconds === 0 → `[思考]`（不显「思考了 0 秒」伪精度）", () => {
    expect(formatThinkingFold(0)).toBe("[思考]");
  });

  test("undefined → `[思考]`（历史消息缺省）", () => {
    expect(formatThinkingFold(undefined)).toBe("[思考]");
  });

  test("负值兜底 → `[思考]`", () => {
    expect(formatThinkingFold(-1)).toBe("[思考]");
  });
});

describe("formatThinkingLive（流式折叠行文案）", () => {
  test("恒为 `思考中…`（实时秒数已下线 — 思考时长由事后 frozen 摘要承担）", () => {
    expect(formatThinkingLive()).toBe("思考中…");
  });
});
