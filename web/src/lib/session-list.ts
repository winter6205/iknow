/**
 * Pure helpers for the session sidebar. Kept free of React/JSX so the root
 * vitest suite (node env, no DOM) can import and test them directly — the web
 * package has no test framework (spec A8/A10 forbid adding one).
 */
import type { SessionListItem } from "../api/types";
import { basename } from "../components/WorkspaceChip";
import { shortId } from "./format";

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

/** Sidebar main-line truncation width (visual contract: one line, 32 chars + ellipsis). */
const SIDEBAR_LINE_MAX = 32;

/**
 * Main line for one sidebar session (spec session-list-title):
 * the header `title`, collapsed and truncated. When the title is empty or
 * whitespace-only, fall back to the existing empty state (conversation-id
 * prefix). Never fall back to lastFinalText — it is a search/filter surface
 * only, never the displayed line.
 */
export function sidebarLineText(session: SessionListItem): string {
  return (
    truncateExcerpt(session.title, SIDEBAR_LINE_MAX) ||
    shortId(session.conversation_id, 8)
  );
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

/**
 * Merge the sentinel key and label into one constant.
 * Both were always the same literal, "(未绑定)" (unbound) — a data clump;
 * now key === label and call sites use the single constant.
 */
export const UNBOUND = "(未绑定)";

/**
 * A sidebar group: one workspace (or the unbound catch-all) plus its sessions
 * already sorted by `sortSessionsByUpdatedDesc`. `isActive` means the active
 * conversation lives in this group; `isUnbound` is the legacy/no-root bucket.
 *
 * Keys must be safe to embed in `localStorage` keys — `/` would split the
 * key shape, so we keep `workspaceRoot` verbatim and encode the whole key at
 * the storage layer (see workspace-groups.ts).
 *
 * Removed `isCurrentRoot` — no consumer ever read it
 * (Speculative Generality); also removed `groupSessionsByWorkspace`'s
 * `currentBoundRoot` param, leaving currentConversationId as the single
 * driver of ordering and flags.
 */
export type WorkspaceGroup = {
  readonly key: string;
  readonly label: string;
  readonly sessions: readonly SessionListItem[];
  readonly latestUpdatedAt: string;
  readonly isActive: boolean;
  readonly isUnbound: boolean;
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
 *
 * The `currentBoundRoot` param is gone — `isActive` is
 * decided by `currentConversationId` alone, and the picker's current root
 * has no effect on sorting (the spec keeps "find the active session" as the
 * ordering priority).
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionListItem[],
  currentConversationId: string | null
): readonly WorkspaceGroup[] {
  if (sessions.length === 0) return [];

  // Bucket by key. We use the raw workspaceRoot as the key (the localStorage
  // layer encodes it separately, so callers don't have to). The unbound bucket
  // uses a sentinel so it never collides with a real path.
  const buckets = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const k =
      s.workspaceRoot && s.workspaceRoot.length > 0 ? s.workspaceRoot : UNBOUND;
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
    const isUnbound = key === UNBOUND;
    // isActive is driven by currentConversationId alone — "where is my live
    // session" matters more than "what root did the picker last show".
    const isActive = currentConversationId
      ? sorted.some((s) => s.conversation_id === currentConversationId)
      : false;
    const latestUpdatedAt = sorted[0]?.updatedAt ?? "";
    groups.push({
      key,
      label: isUnbound ? UNBOUND : basename(key),
      sessions: sorted,
      latestUpdatedAt,
      isActive,
      isUnbound,
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
