/**
 * Copy-decision unit tests for the pure function
 * compactNoticeFor(reason, compacted).
 *
 * Certified invariants:
 * 1. manual /compact success copy (windowed / full_summary) says only
 *    "compaction happened";
 * 2. "auto token gate not met" copy is forbidden on the manual path —
 *    hub.compactSession no longer returns below_token_threshold, so
 *    receiving that reason is a contract breach and must throw rather than
 *    degrade into threshold copy;
 * 3. the noop path (reason=messages_too_few) means "nothing compactable",
 *    covering both the empty-session idempotent case and total compaction
 *    failure, without referencing the auto threshold.
 */
import { describe, expect, test } from "bun:test";
import { compactNoticeFor } from "../../src/tui/app.tsx";

describe("compactNoticeFor — /compact notice 文案决策", () => {
  test("compacted=true + reason='windowed' → 「Context compacted (kept tail, trimmed early messages).」", () => {
    const lines = compactNoticeFor("windowed", true);
    expect(lines).toEqual([
      "Context compacted (kept tail, trimmed early messages).",
    ]);
  });

  test("compacted=true + reason='full_summary' → 「Context compacted (structured summary + kept tail).」", () => {
    const lines = compactNoticeFor("full_summary", true);
    expect(lines).toEqual([
      "Context compacted (structured summary + kept tail).",
    ]);
  });

  test("compacted=false + reason='messages_too_few' → 「Nothing to compact」语义（空会话/整体失败共用）", () => {
    const lines = compactNoticeFor("messages_too_few", false);
    expect(lines).toEqual(["Nothing to compact — session unchanged."]);
  });

  test("auto token 门文案禁止出现在手动路径:below_token_threshold 在 compacted=false 下抛错", () => {
    // Manual compactSession never returns below_token_threshold; its
    // appearance is a contract breach, so throwing beats showing auto
    // threshold copy to the user.
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
