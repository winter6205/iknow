import type { SessionListItem } from "../api/types";
import { basename } from "../components/WorkspaceChip";

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

/** Sentinel key for the "unbound" group (session has no workspaceRoot). */
export const UNBOUND_KEY = "(未绑定)";
/** Display label shared by every member of the unbound group. */
export const UNBOUND_LABEL = "(未绑定)";

/**
 * A sidebar group: one workspace (or the unbound catch-all) plus its sessions
 * already sorted by `sortSessionsByUpdatedDesc`. `isActive` means the active
 * conversation lives in this group; `isUnbound` is the legacy/no-root bucket;
 * `isCurrentRoot` means this group's workspaceRoot matches the picker's
 * currently-bound root (informational — for "current" badge rendering).
 *
 * Keys must be safe to embed in `localStorage` keys — `/` would split the
 * key shape, so we keep `workspaceRoot` verbatim and encode the whole key at
 * the storage layer (see workspace-groups.ts).
 */
export type WorkspaceGroup = {
  readonly key: string;
  readonly label: string;
  readonly sessions: readonly SessionListItem[];
  readonly latestUpdatedAt: string;
  readonly isActive: boolean;
  readonly isUnbound: boolean;
  readonly isCurrentRoot: boolean;
};

/**
 * Bucket sessions by `workspaceRoot` and return the groups in display order:
 *  1. The group containing the active conversation first (so the user can
 *     always see where the live session lives, even if they switched roots).
 *  2. Remaining groups by their newest `updatedAt` descending.
 *  3. The `(未绑定)` group pinned to the end no matter what.
 *
 * Inside each group, sessions are still `sortSessionsByUpdatedDesc` — we don't
 * change the per-group ordering contract. The function is pure: input array is
 * not mutated, and output contains no references to caller-owned objects that
 * could leak back.
 *
 * Empty input → empty output (no synthetic "(未绑定)" group; that's a UI-only
 * concern).
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionListItem[],
  currentConversationId: string | null,
  currentBoundRoot: string | null
): readonly WorkspaceGroup[] {
  if (sessions.length === 0) return [];

  // Bucket by key. We use the raw workspaceRoot as the key (the localStorage
  // layer encodes it separately, so callers don't have to). The unbound bucket
  // uses a sentinel so it never collides with a real path.
  const buckets = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const k =
      s.workspaceRoot && s.workspaceRoot.length > 0
        ? s.workspaceRoot
        : UNBOUND_KEY;
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(s);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [key, arr] of buckets) {
    const sorted = sortSessionsByUpdatedDesc(arr);
    const isUnbound = key === UNBOUND_KEY;
    // isActive is driven by currentConversationId alone — "where is my live
    // session" matters more than "what root did the picker last show".
    const isActive = currentConversationId
      ? sorted.some((s) => s.conversation_id === currentConversationId)
      : false;
    // isCurrentRoot is purely informational; does NOT influence sort order
    // (the spec keeps "find the live session" as the sort priority).
    const isCurrentRoot =
      !isUnbound && currentBoundRoot !== null && key === currentBoundRoot;
    const latestUpdatedAt = sorted[0]?.updatedAt ?? "";
    groups.push({
      key,
      label: isUnbound ? UNBOUND_LABEL : basename(key),
      sessions: sorted,
      latestUpdatedAt,
      isActive,
      isUnbound,
      isCurrentRoot,
    });
  }

  groups.sort((a, b) => {
    // 1) Active group always first.
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    // 2) Unbound always last.
    if (a.isUnbound !== b.isUnbound) return a.isUnbound ? 1 : -1;
    // 3) Newest-first by group latestUpdatedAt (lexical == chronological).
    return b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
  });

  return groups;
}
