/** Standalone Reciprocal Rank Fusion (k=60). No external package imports. */
export const RRF_K = 60;

export interface RankedHit {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: score += 1 / (k + rank), ranks are 0-based.
 * Then normalize to max=1 and sort descending.
 */
export function rrfFusion(
  lists: RankedHit[][],
  k: number = RRF_K,
): RankedHit[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      if (!hit) continue;
      const add = 1 / (k + rank);
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + add);
    }
  }

  if (scores.size === 0) return [];

  const max = Math.max(...scores.values());
  const fused: RankedHit[] = [];
  for (const [id, raw] of scores) {
    fused.push({ id, score: max > 0 ? raw / max : 0 });
  }
  fused.sort((a, b) => b.score - a.score);
  return fused;
}
