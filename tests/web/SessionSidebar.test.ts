/**
 * SessionSidebar pure-helper tests.
 *
 * The web package has no test framework (project constraints forbid adding
 * one), so we
 * test the sidebar's pure logic — extracted to web/src/lib/session-list.ts and
 * free of React/JSX — here under the root vitest (node env). The component
 * itself (SessionSidebar.tsx) is not rendered; only its helpers are.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isCurrentSession,
  sidebarLineText,
  sortSessionsByUpdatedDesc,
  truncateExcerpt,
} from "../../web/src/lib/session-list.ts";
import type { SessionListItem } from "../../web/src/api/types.ts";

function item(opts: {
  readonly id: string;
  readonly updatedAt: string;
  readonly lastFinalText?: string;
  readonly title?: string;
}): SessionListItem {
  const { id, updatedAt, lastFinalText = "", title = "" } = opts;
  return { conversation_id: id, updatedAt, lastFinalText, title };
}

describe("sortSessionsByUpdatedDesc", () => {
  it("sorts most-recent first by ISO updatedAt", () => {
    const input = [
      item({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "new", updatedAt: "2026-07-30T12:00:00.000Z" }),
      item({ id: "mid", updatedAt: "2026-04-15T06:30:00.000Z" }),
    ];
    const out = sortSessionsByUpdatedDesc(input);
    assert.deepEqual(
      out.map((s) => s.conversation_id),
      ["new", "mid", "old"]
    );
  });

  it("does not mutate the input array", () => {
    const input = [
      item({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "b", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ];
    sortSessionsByUpdatedDesc(input);
    assert.deepEqual(
      input.map((s) => s.conversation_id),
      ["a", "b"]
    );
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(sortSessionsByUpdatedDesc([]), []);
  });

  it("keeps a single element unchanged", () => {
    const only = [item({ id: "solo", updatedAt: "2026-07-30T00:00:00.000Z" })];
    const out = sortSessionsByUpdatedDesc(only);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.conversation_id, "solo");
  });

  it("sinks missing updatedAt to the end", () => {
    const input = [
      item({ id: "missing", updatedAt: "" }),
      item({ id: "dated", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ];
    const out = sortSessionsByUpdatedDesc(input);
    assert.deepEqual(
      out.map((s) => s.conversation_id),
      ["dated", "missing"]
    );
  });

  it("is stable for equal timestamps (preserves input order)", () => {
    const input = [
      item({ id: "first", updatedAt: "2026-07-30T00:00:00.000Z" }),
      item({ id: "second", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ];
    const out = sortSessionsByUpdatedDesc(input);
    assert.deepEqual(
      out.map((s) => s.conversation_id),
      ["first", "second"]
    );
  });
});

describe("truncateExcerpt", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncateExcerpt("hello world", 80), "hello world");
  });

  it("truncates long text and appends an ellipsis", () => {
    const out = truncateExcerpt("abcdefghij", 5);
    assert.equal(out, "abcde…");
  });

  it("collapses internal whitespace before truncating", () => {
    assert.equal(truncateExcerpt("a   b\n\tc", 80), "a b c");
  });

  it("trims trailing whitespace introduced by the cut", () => {
    // "abcdef" cut at 3 → "abc"; with a space at the boundary the trailing
    // space is removed before the ellipsis.
    assert.equal(truncateExcerpt("ab cdef", 3), "ab…");
  });

  it("returns empty string for non-positive max", () => {
    assert.equal(truncateExcerpt("anything", 0), "");
    assert.equal(truncateExcerpt("anything", -5), "");
  });

  it("returns empty string for empty input", () => {
    assert.equal(truncateExcerpt("", 80), "");
    assert.equal(truncateExcerpt("   \n\t  ", 80), "");
  });

  it("does not add an ellipsis when length equals max exactly", () => {
    assert.equal(truncateExcerpt("abcde", 5), "abcde");
  });
});

describe("isCurrentSession", () => {
  it("is true when ids match", () => {
    assert.equal(isCurrentSession("conv-1", "conv-1"), true);
  });

  it("is false when ids differ", () => {
    assert.equal(isCurrentSession("conv-1", "conv-2"), false);
  });

  it("is false when current id is null (no session yet)", () => {
    assert.equal(isCurrentSession("conv-1", null), false);
  });

  it("is false when the entry id is null", () => {
    assert.equal(isCurrentSession(null, "conv-1"), false);
  });

  it("is false when both ids are empty strings", () => {
    assert.equal(isCurrentSession("", ""), false);
  });

  it("is false for undefined inputs", () => {
    assert.equal(isCurrentSession(undefined, undefined), false);
  });
});

// Per specs/session-list-title.md "Does not" (lastFinalText is never shown as the primary line):
// sidebar primary line = header title (truncated to 32); an empty / whitespace-only
// title falls back to the existing empty state (conversation id prefix), never to lastFinalText.
describe("sidebarLineText", () => {
  it("有 title 时主行 = title", () => {
    const s = item({
      id: "conv-abc-123",
      updatedAt: "2026-07-30T00:00:00.000Z",
      title: "重构会话列表标题",
      lastFinalText: "已完成重构",
    });
    assert.equal(sidebarLineText(s), "重构会话列表标题");
  });

  it("长 title 折叠空白并截断到 32 字符加省略号", () => {
    const s = item({
      id: "conv-abc-123",
      updatedAt: "2026-07-30T00:00:00.000Z",
      title: "a   b\n\t" + "x".repeat(40),
    });
    const out = sidebarLineText(s);
    assert.ok(out.endsWith("…"));
    assert.equal(out.length, 33); // 32 + ellipsis
  });

  it("title 为空串时走空态（id 前缀），不 fallback 到 lastFinalText", () => {
    const s = item({
      id: "conv-abc-1234567890",
      updatedAt: "2026-07-30T00:00:00.000Z",
      title: "",
      lastFinalText: "助手的最终回复内容",
    });
    const out = sidebarLineText(s);
    assert.equal(out, "conv-abc…");
    assert.ok(!out.includes("助手的最终回复内容"));
  });

  it("title 为纯空白时同样走空态", () => {
    const s = item({
      id: "conv-abc-1234567890",
      updatedAt: "2026-07-30T00:00:00.000Z",
      title: "   \n\t ",
      lastFinalText: "some answer",
    });
    assert.equal(sidebarLineText(s), "conv-abc…");
  });
});
