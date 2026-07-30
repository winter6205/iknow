import type { SessionListItem } from "../api/types";

/**
 * Pure helpers for the session sidebar. Kept free of React/JSX so the root
 * vitest suite (node env, no DOM) can import and test them directly — the web
 * package has no test framework (spec A8/A10 forbid adding one).
 */

/**
 * Return a new array sorted by updatedAt descending (most recent first).
 * Does not mutate the input. updatedAt is an ISO-8601 string, so lexical
 * comparison equals chronological comparison; missing values sink to the end.
 */
export function sortSessionsByUpdatedDesc(
  sessions: readonly SessionListItem[]
): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    const au = a.updatedAt ?? "";
    const bu = b.updatedAt ?? "";
    return bu.localeCompare(au);
  });
}

/**
 * Collapse whitespace and truncate an excerpt for single-line sidebar display.
 * Returns "" for empty / non-positive max. Appends an ellipsis only when the
 * collapsed text actually exceeds max.
 */
export function truncateExcerpt(text: string, max: number): string {
  if (max <= 0) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * True when a sidebar entry is the active conversation. Both ids must be
 * non-empty and equal; a null/empty current id (no session yet) never matches.
 */
export function isCurrentSession(
  id: string | null | undefined,
  currentId: string | null | undefined
): boolean {
  if (!id || !currentId) return false;
  return id === currentId;
}
