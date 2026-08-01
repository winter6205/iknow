/**
 * SessionSidebar pure-helper tests (T8).
 *
 * The web package has no test framework (spec A8/A10 forbid adding one), so we
 * test the sidebar's pure logic — extracted to web/src/lib/session-list.ts and
 * free of React/JSX — here under the root vitest (node env). The component
 * itself (SessionSidebar.tsx) is not rendered; only its helpers are.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isCurrentSession,
  sortSessionsByUpdatedDesc,
  truncateExcerpt,
} from "../../web/src/lib/session-list.ts";
import type { SessionListItem } from "../../web/src/api/types.ts";

function item(opts: {
  readonly id: string;
  readonly updatedAt: string;
  readonly lastFinalText?: string;
}): SessionListItem {
  const { id, updatedAt, lastFinalText = "" } = opts;
  return { conversation_id: id, updatedAt, lastFinalText };
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
