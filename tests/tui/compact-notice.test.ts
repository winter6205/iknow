/**
 * plan compress-trigger-gate T4 + review-fix:为 src/tui/app.tsx 的
 * compactNoticeFor(reason, compacted) 纯函数覆盖 4 reason × 2 compacted
 * 状态。TUI 文案决策原嵌在 /compact handler 的 inline switch 内,review
 * 指出缺独立单测;现抽成 module-level pure function 后用 bun:test 单测。
 *
 * 注意:TUI 默认 test runner 是 bun:test(`npm test` 第二阶段跑
 * `bun test tests/tui/`),不在 vitest 默认 config 内。
 */
import { describe, expect, test } from "bun:test";
import { compactNoticeFor } from "../../src/tui/app.tsx";

describe("compactNoticeFor — /compact notice 文案决策 (plan T4 + review-fix)", () => {
  test("compacted=true + reason='windowed' → 「已压缩上下文（保留尾部，裁剪早期消息）。」", () => {
    const lines = compactNoticeFor("windowed", true);
    expect(lines).toEqual(["已压缩上下文（保留尾部，裁剪早期消息）。"]);
  });

  test("compacted=true + reason='full_summary' → 「已通过结构化摘要压缩上下文（保留尾部 + 摘要前缀）。」", () => {
    const lines = compactNoticeFor("full_summary", true);
    expect(lines).toEqual([
      "已通过结构化摘要压缩上下文（保留尾部 + 摘要前缀）。",
    ]);
  });

  test("compacted=false + reason='below_token_threshold' → 「当前 token 未达压缩阈值，无需压缩。」", () => {
    const lines = compactNoticeFor("below_token_threshold", false);
    expect(lines).toEqual(["当前 token 未达压缩阈值，无需压缩。"]);
  });

  test("compacted=false + reason='messages_too_few' → 「消息条数过少，无法做窗口压缩，且摘要失败 — 上下文保持原样。」", () => {
    const lines = compactNoticeFor("messages_too_few", false);
    expect(lines).toEqual([
      "消息条数过少，无法做窗口压缩，且摘要失败 — 上下文保持原样。",
    ]);
  });

  test("exhaustiveness 守门:compacted=true 路径收到 below_token_threshold 抛错", () => {
    expect(() => compactNoticeFor("below_token_threshold", true)).toThrow(
      /unexpected no-op reason in compacted branch/
    );
  });

  test("exhaustiveness 守门:compacted=false 路径收到 full_summary 抛错", () => {
    expect(() => compactNoticeFor("full_summary", false)).toThrow(
      /unexpected compressed-state reason in noop branch/
    );
  });
});
