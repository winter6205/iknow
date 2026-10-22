/**
 * NDJSON decoder tests (spec specs/remote-sync.md §5.1).
 *
 * Why a dedicated suite: the seat socket reads arbitrary TCP-like chunks, so
 * line splitting and the 1 MiB frame cap are the contract that keeps one
 * oversized client frame from corrupting the parse of its neighbours. The
 * UTF-8 cases pin that a chunk boundary inside a multibyte sequence is not
 * treated as a line break and does not produce replacement characters.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createNdjsonDecoder } from "../../src/remote-api/codec.ts";

describe("createNdjsonDecoder", () => {
  it("splits several newline-terminated lines in one chunk", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 64 });
    const result = decoder.push("one\ntwo\nthree\n");
    assert.deepEqual(result.lines, ["one", "two", "three"]);
    assert.equal(result.overflow, undefined);
  });

  it("holds an unterminated tail until the next chunk", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 64 });
    assert.deepEqual(decoder.push("a\nb").lines, ["a"]);
    assert.deepEqual(decoder.push("c\n").lines, ["bc"]);
    assert.deepEqual(decoder.push("").lines, []);
  });

  it("decodes a multibyte character split across a chunk boundary", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 64 });
    const bytes = Buffer.from('{"text":"héllo ✓"}\n', "utf8");
    const checkAt = bytes.indexOf(Buffer.from("✓", "utf8")) + 1;
    const first = decoder.push(bytes.subarray(0, checkAt));
    assert.deepEqual(first.lines, []);
    const second = decoder.push(bytes.subarray(checkAt));
    assert.deepEqual(second.lines, ['{"text":"héllo ✓"}']);
  });

  it("accepts a line that is exactly the byte cap", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 4 });
    assert.deepEqual(decoder.push("abcd\n").lines, ["abcd"]);
  });

  it("reports overflow for an unterminated line over the cap", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 8 });
    const result = decoder.push("123456789");
    assert.deepEqual(result.lines, []);
    assert.equal(result.overflow, true);
  });

  it("reports overflow for a terminated line over the cap and keeps earlier lines", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 8 });
    const result = decoder.push("ok\n123456789\n");
    assert.deepEqual(result.lines, ["ok"]);
    assert.equal(result.overflow, true);
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 6 });
    // Three 3-byte characters = 9 bytes > 6.
    assert.equal(decoder.push("✓✓✓").overflow, true);
  });

  it("stays in the overflow state and stops splitting", () => {
    const decoder = createNdjsonDecoder({ maxLineBytes: 4 });
    assert.equal(decoder.push("12345").overflow, true);
    const after = decoder.push("ok\n");
    assert.deepEqual(after.lines, []);
    assert.equal(after.overflow, true);
  });
});
