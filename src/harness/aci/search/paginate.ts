/**
 * Pagination of the result roster.
 *
 * All three output modes share one offset / head_limit scheme — the output
 * mode only decides "what goes into the roster", never "how it is sliced".
 * What gets sliced is the **already sorted** roster (see `sort.ts`).
 *
 * Receipt semantics:
 *   - Empty roster (the query truly has no hits) → empty string.
 *   - Non-empty roster but offset past the last entry → exactly
 *     `No entries at this offset`.
 *   The two receipts are mutually exclusive and neither is a "no matches"
 *   message — the model uses them to tell "try another word" apart from
 *   "paged past the end".
 */

/** The exact past-the-end receipt; not an empty string, not a "no matches" message. */
export const NO_ENTRIES_AT_OFFSET = "No entries at this offset";

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  /**
   * True when the roster is non-empty but the offset is past the last entry;
   * the caller answers `NO_ENTRIES_AT_OFFSET` accordingly.
   */
  readonly beyondEnd: boolean;
}

/**
 * Slice a page.
 *
 * `items` must be the sorted roster. An empty roster yields
 * `{ items: [], beyondEnd: false }` (no matches renders as an empty string,
 * not as the past-the-end receipt).
 */
export function paginate<T>(
  items: ReadonlyArray<T>,
  offset: number,
  headLimit: number
): Page<T> {
  if (items.length === 0) return { items: [], beyondEnd: false };
  if (offset >= items.length) return { items: [], beyondEnd: true };
  return {
    items: items.slice(offset, offset + headLimit),
    beyondEnd: false,
  };
}
