import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { GOV_LABEL, shortSnap } from "../../web/src/components/evidence.ts";

describe("shortSnap", () => {
  it("removes the snap_ prefix and uses the default eight-character limit", () => {
    assert.equal(shortSnap("snap_123456789"), "12345678");
  });

  it("preserves an identifier without the snap_ prefix", () => {
    assert.equal(shortSnap("abcdefghijk", 5), "abcde");
  });

  it("returns an empty string for empty input or a zero limit", () => {
    assert.equal(shortSnap(""), "");
    assert.equal(shortSnap("snap_abcdef", 0), "");
  });

  it("uses String.slice semantics for a negative limit", () => {
    assert.equal(shortSnap("snap_abcdef", -1), "abcde");
  });

  it("returns the full bare id when the limit exceeds its length", () => {
    assert.equal(shortSnap("snap_abc", Number.MAX_SAFE_INTEGER), "abc");
  });
});

describe("GOV_LABEL", () => {
  it("defines the labels for every governance status", () => {
    assert.deepEqual(GOV_LABEL, {
      ok: "已核验",
      stale: "已过期",
      conflict: "存在冲突",
    });
  });
});
