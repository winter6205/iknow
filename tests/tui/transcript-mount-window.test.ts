/**
 * tests/tui/transcript-mount-window.test.ts
 *
 * ChatView 不得把整段 session 挂进 OpenTUI 树。本模块是消息级尾窗
 * （非行账）：只决定 mount 哪些消息，不估算行高。
 */
import { describe, expect, test } from "bun:test";
import {
  TRANSCRIPT_REVEAL_PAGE,
  TRANSCRIPT_TAIL_DEFAULT,
  formatEarlierMessagesStub,
  selectTranscriptMountWindow,
} from "../../src/tui/transcript-mount-window.js";

function ids(n: number): ReadonlyArray<string> {
  return Array.from({ length: n }, (_, i) => `m-${i}`);
}

describe("selectTranscriptMountWindow", () => {
  test("empty: 空数组 hiddenCount=0 mounted=[]", () => {
    const w = selectTranscriptMountWindow([], TRANSCRIPT_TAIL_DEFAULT);
    expect(w.mounted).toEqual([]);
    expect(w.hiddenCount).toBe(0);
    expect(w.startIndex).toBe(0);
    expect(formatEarlierMessagesStub(w.hiddenCount)).toBeNull();
  });

  test("negative: revealedCount<=0 回退默认尾窗，不把会话渲成空白", () => {
    const messages = ids(10);
    const w = selectTranscriptMountWindow(messages, -3);
    expect(w.mounted).toEqual([...messages]);
    expect(w.hiddenCount).toBe(0);
  });

  test("overflow: 超长会话只 mount 尾部 DEFAULT 条", () => {
    const messages = ids(100);
    const w = selectTranscriptMountWindow(messages, TRANSCRIPT_TAIL_DEFAULT);
    expect(w.mounted).toHaveLength(TRANSCRIPT_TAIL_DEFAULT);
    expect(w.hiddenCount).toBe(100 - TRANSCRIPT_TAIL_DEFAULT);
    expect(w.startIndex).toBe(100 - TRANSCRIPT_TAIL_DEFAULT);
    expect(w.mounted[0]).toBe(`m-${w.startIndex}`);
    expect(w.mounted.at(-1)).toBe("m-99");
    expect(formatEarlierMessagesStub(w.hiddenCount)).toBe(
      `↑ ${w.hiddenCount} 条更早的消息`
    );
  });

  test("overflow: revealedCount 非有限数回退默认尾窗", () => {
    const w = selectTranscriptMountWindow(ids(80), Number.POSITIVE_INFINITY);
    expect(w.mounted).toHaveLength(TRANSCRIPT_TAIL_DEFAULT);
    expect(w.hiddenCount).toBe(80 - TRANSCRIPT_TAIL_DEFAULT);
  });

  test("concurrent: 纯函数两次调用互不影响 // N/A: pure", async () => {
    const [a, b] = await Promise.all([
      Promise.resolve(selectTranscriptMountWindow(ids(100), 32)),
      Promise.resolve(selectTranscriptMountWindow(ids(5), 32)),
    ]);
    expect(a.hiddenCount).toBe(68);
    expect(b.hiddenCount).toBe(0);
    expect(b.mounted).toHaveLength(5);
  });

  test("exception: messages 非数组抛 TypeError", () => {
    expect(() =>
      selectTranscriptMountWindow(null as unknown as ReadonlyArray<string>, 32)
    ).toThrow(TypeError);
  });

  test("reveal page 增大尾窗直到全量", () => {
    const messages = ids(100);
    const first = selectTranscriptMountWindow(
      messages,
      TRANSCRIPT_TAIL_DEFAULT
    );
    const second = selectTranscriptMountWindow(
      messages,
      TRANSCRIPT_TAIL_DEFAULT + TRANSCRIPT_REVEAL_PAGE
    );
    expect(second.hiddenCount).toBeLessThan(first.hiddenCount);
    const all = selectTranscriptMountWindow(messages, 10_000);
    expect(all.hiddenCount).toBe(0);
    expect(all.mounted).toHaveLength(100);
    expect(formatEarlierMessagesStub(all.hiddenCount)).toBeNull();
  });
});
