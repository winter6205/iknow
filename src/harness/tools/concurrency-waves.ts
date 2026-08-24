/**
 * #653 P: consecutive isConcurrencySafe items share a wave; unsafe items
 * are singleton waves (wave-breakers). Used by ACI executeAll and runToolPhase.
 */
export function partitionConcurrencyWaves<T>(
  items: ReadonlyArray<T>,
  isConcurrencySafe: (item: T) => boolean
): ReadonlyArray<ReadonlyArray<T>> {
  const waves: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    if (isConcurrencySafe(item)) {
      current.push(item);
      continue;
    }
    if (current.length > 0) {
      waves.push(current);
      current = [];
    }
    waves.push([item]);
  }
  if (current.length > 0) waves.push(current);
  return waves;
}
