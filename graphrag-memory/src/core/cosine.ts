/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Pure function — no side effects, no I/O. Suitable for both sync hot paths
 * (in-process vector search) and unit tests.
 *
 * Returns 0 when either vector has zero magnitude (division-by-zero guard).
 * A zero-magnitude input is treated as "no signal" rather than NaN/Infinity
 * so callers (e.g. ranking) can compare scores without branching on NaN.
 *
 * Throws RangeError when the two input vectors have different lengths:
 * mismatched dimensions are a caller bug, not a similarity-of-0 case.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSimilarity: length mismatch (a=${a.length}, b=${b.length})`
    );
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
