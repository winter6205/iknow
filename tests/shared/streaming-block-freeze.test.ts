/**
 * tests/shared/streaming-block-freeze.test.ts — pure function freezing top-level streaming blocks.
 *
 * EXIT criteria: empty input; single block has no prefix; with multiple blocks the
 * prefix raw stays stable as the suffix grows and the boundary is monotonically
 * non-decreasing; non-string input throws TypeError; two computations share no mutable boundary.
 */
import { describe, expect, test } from "vitest";
import { splitStreamingMarkdown } from "../../src/shared/streaming-block-freeze.js";

describe("splitStreamingMarkdown", () => {
  test("empty：空串无前缀可钉", () => {
    expect(splitStreamingMarkdown("")).toEqual({
      prefixRaw: "",
      tailRaw: "",
      boundary: 0,
    });
  });

  test("只有一个顶层块：前缀空、边界为 0", () => {
    const text = "only one block";
    expect(splitStreamingMarkdown(text)).toEqual({
      prefixRaw: "",
      tailRaw: text,
      boundary: 0,
    });
  });

  test("多块：后缀变长时前缀 raw 不变且边界不回退", () => {
    const closed = "first paragraph";
    const sep = "\n\n";
    const first = splitStreamingMarkdown(`${closed}${sep}second`);
    expect(first.prefixRaw).toBe(`${closed}${sep}`);
    expect(first.tailRaw).toBe("second");
    const grown = splitStreamingMarkdown(
      `${closed}${sep}second grows`,
      first.boundary
    );
    expect(grown.prefixRaw).toBe(first.prefixRaw);
    expect(grown.boundary).toBe(first.boundary);
    expect(grown.tailRaw).toBe("second grows");
    expect(grown.boundary).toBeGreaterThanOrEqual(first.boundary);
  });

  test("前缀在后续调用不得变短", () => {
    const a = splitStreamingMarkdown("alpha\n\nbeta");
    const b = splitStreamingMarkdown("alpha\n\nbeta\n\ngamma", a.boundary);
    expect(b.boundary).toBeGreaterThanOrEqual(a.boundary);
    expect(b.prefixRaw.startsWith(a.prefixRaw)).toBe(true);
    expect(b.prefixRaw.length).toBeGreaterThanOrEqual(a.prefixRaw.length);
  });

  test("concurrent：两次冻结计算互不影响", () => {
    const left = splitStreamingMarkdown("L1\n\nL2");
    const right = splitStreamingMarkdown("R1\n\nR2 extra");
    expect(left.prefixRaw).toBe("L1\n\n");
    expect(right.prefixRaw).toBe("R1\n\n");
    expect(left.tailRaw).toBe("L2");
    expect(right.tailRaw).toBe("R2 extra");
  });

  test("exception：非字符串抛 TypeError", () => {
    expect(() => splitStreamingMarkdown(1)).toThrow(TypeError);
    expect(() => splitStreamingMarkdown(null)).toThrow(TypeError);
  });
});
