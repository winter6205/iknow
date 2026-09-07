/**
 * compactNoticeFor(reason, compacted) 纯函数的文案决策单测。
 *
 * 认证的不变式（plan manual-compact-trigger T2）：
 * 1. 手动 /compact 路径的成功文案（windowed / full_summary）只说「压缩已发生」；
 * 2. 「auto token 门未过」类文案禁止出现在手动路径 —— T1 后 hub.compactSession
 *    不再返回 below_token_threshold，收到该 reason 属于契约破坏，必须抛错而非
 *    降级成阈值文案；
 * 3. noop 路径（reason=messages_too_few）语义是「没有可压缩的上下文」，覆盖
 *    空会话幂等与压缩整体失败两种来源，不引用 auto 阈值。
 */
import { describe, expect, test } from "bun:test";
import { compactNoticeFor } from "../../src/tui/app.tsx";

describe("compactNoticeFor — /compact notice 文案决策", () => {
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

  test("compacted=false + reason='messages_too_few' → 「没有可压缩的上下文」语义（空会话/整体失败共用）", () => {
    const lines = compactNoticeFor("messages_too_few", false);
    expect(lines).toEqual(["没有可压缩的上下文，会话保持原样。"]);
  });

  test("auto token 门文案禁止出现在手动路径:below_token_threshold 在 compacted=false 下抛错", () => {
    // T1 后手动 compactSession 不返回 below_token_threshold;若出现即契约破坏,
    // 抛错优于把 auto 阈值文案呈现给用户(manual-compact-trigger T2)。
    expect(() => compactNoticeFor("below_token_threshold", false)).toThrow(
      /unexpected reason in manual noop branch/
    );
  });

  test("exhaustiveness 守门:compacted=true 路径收到 no-op reason 抛错", () => {
    expect(() => compactNoticeFor("below_token_threshold", true)).toThrow(
      /unexpected no-op reason in compacted branch/
    );
    expect(() => compactNoticeFor("messages_too_few", true)).toThrow(
      /unexpected no-op reason in compacted branch/
    );
  });

  test("exhaustiveness 守门:compacted=false 路径收到压缩成功 reason 抛错", () => {
    expect(() => compactNoticeFor("full_summary", false)).toThrow(
      /unexpected reason in manual noop branch/
    );
    expect(() => compactNoticeFor("windowed", false)).toThrow(
      /unexpected reason in manual noop branch/
    );
  });
});
