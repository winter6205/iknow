import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../src/core/cosine.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBe(1);
  });

  it("returns 1 for scaled identical vectors (direction-agnostic)", () => {
    // 2*[1,2,3] and [1,2,3] point the same way
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBe(-1);
  });

  it("returns 0 when the first vector is the zero vector", () => {
    // Guard against division by zero
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when the second vector is the zero vector", () => {
    // Guard against division by zero
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0 when both vectors are zero", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("handles large-dim vectors (representative dimension)", () => {
    // Build two vectors at a representative embedding dimension with a
    // known dot product. cosine logic is dimension-agnostic; this test
    // exists to catch regressions in any vectorization assumption.
    const dim = 1536;
    const a = new Array<number>(dim);
    const b = new Array<number>(dim);
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < dim; i++) {
      const av = (i + 1) / dim; // deterministic, non-zero
      const bv = (dim - i) / dim;
      a[i] = av;
      b[i] = bv;
      dot += av * bv;
      magA += av * av;
      magB += bv * bv;
    }
    const expected = dot / (Math.sqrt(magA) * Math.sqrt(magB));
    const actual = cosineSimilarity(a, b);
    expect(actual).toBeCloseTo(expected, 10);
    // Deterministic non-aligned vectors should not collapse to 1 or 0
    expect(Math.abs(actual - 1)).toBeGreaterThan(0);
    expect(Math.abs(actual)).toBeLessThan(1);
  });

  it("returns a value in [-1, 1] for arbitrary real vectors", () => {
    const score = cosineSimilarity(
      [0.3, -0.7, 0.1, 0.5],
      [-0.2, 0.4, 0.9, -0.1]
    );
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });
});
