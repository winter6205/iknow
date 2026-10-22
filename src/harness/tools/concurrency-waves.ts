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

/**
 * The concurrency-safety contract of one tool, as the wave splitter sees it.
 *
 * `isConcurrencySafe` is the tool-level DEFAULT: it applies to every call of
 * the tool that carries no per-call verdict of its own.
 *
 * `isConcurrencySafeForInput` is the tool-level PER-CALL predicate: when a
 * tool declares it, it DECIDES for every call of that tool, and the static
 * default is not consulted for that call at all. It lets a tool say "this
 * particular call is safe to run concurrently" from the call's own input (a
 * read-only command versus a mutating one, for example).
 *
 * The predicate is AUTHORITATIVE for the calls of the tool that declares it
 * — in both directions: it may declare a call safe that the static default
 * called unsafe (bash: a read-only command) and unsafe that the static
 * default called safe. What may never happen is an UNCERTAIN answer
 * widening concurrency: an unknown tool, a predicate that throws, and a
 * predicate that returns anything other than exactly `true` all mean "not
 * concurrency-safe" — never "safe". A tool that cannot answer with
 * certainty runs alone.
 */
export interface ConcurrencySafetyMeta {
  readonly isConcurrencySafe: boolean;
  readonly isConcurrencySafeForInput?: (input: unknown) => boolean;
}

/**
 * Resolve ONE call's concurrency safety.
 *
 *   - no meta (unknown tool) → false (conservative: an unknown tool may not
 *     be assumed to be safe);
 *   - a declared predicate → it decides: `predicate(input) === true`. A
 *     predicate that THROWS is answered with false, because an uncertain
 *     answer must never widen concurrency (a throwing predicate may only ever
 *     make the call more conservative);
 *   - no predicate → the static tool-level default decides.
 */
export function isConcurrencySafeForCall(
  meta: ConcurrencySafetyMeta | undefined,
  input: unknown
): boolean {
  if (meta === undefined) return false;
  const predicate = meta.isConcurrencySafeForInput;
  if (typeof predicate !== "function") return meta.isConcurrencySafe === true;
  try {
    return predicate(input) === true;
  } catch {
    // EXIT: an uncertain answer must never widen concurrency ⇒ serial.
    return false;
  }
}
