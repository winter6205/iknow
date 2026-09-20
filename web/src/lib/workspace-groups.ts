/**
 * localStorage persistence for sidebar workspace-group
 * collapsed state + lazy loading.
 *
 * Design points:
 *  - Key shape `sidebar.workspaceGroups.<encoded>`, where `<encoded>` is
 *    base64(workspaceRoot) or base64("(未绑定)") — the "/" inside paths can
 *    no longer break the localStorage key shape.
 *  - Only non-active groups' collapsed state is persisted; the active group
 *    stays expanded and the UI must not write it (just don't call
 *    saveCollapsed). After a page refresh the user can never collapse "where
 *    I am right now".
 *  - Browser-only: btoa + TextEncoder path; the Node/Buffer fallback was
 *    removed. Node 20+ has a global btoa, so vitest in
 *    node env still goes through btoa.
 *  - `CollapsedStateStore` wraps lazy init / in-memory cache / persist
 *    in one `useRef` instance, so `useWorkspaceGroups` no longer re-inits
 *    via useEffect([groups]) — a groups-array identity change can no longer
 *    wipe the user's toggles.
 */

const STORAGE_PREFIX = "sidebar.workspaceGroups.";

/**
 * Encode workspaceRoot into a stable localStorage key segment. Uses base64 so
 * POSIX paths and the unbound sentinel never contain characters that would
 * confuse the key shape (`/`, spaces). Two calls with the same root return
 * the same key.
 *
 * Browser-only path: `btoa(String.fromCharCode(...new TextEncoder().encode(root)))`.
 * `unescape` was deprecated (see MDN); TextEncoder produces UTF-8 bytes which
 * `String.fromCharCode` maps to a binary string, then `btoa` base64-encodes.
 */
export function collapseKey(root: string): string {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(root)));
  return STORAGE_PREFIX + encoded;
}

/**
 * Read the persisted collapsed flag. Missing / corrupt storage → false. SSR /
 * privacy-mode → false. Never throws.
 */
export function loadCollapsed(root: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(collapseKey(root));
    return raw === "true";
  } catch {
    return false;
  }
}

/**
 * Persist a collapsed flag. SSR / quota-exceeded → no-op. Never throws.
 * The UI is responsible for not calling this with `root === activeGroup.key`.
 */
export function saveCollapsed(root: string, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(collapseKey(root), collapsed ? "true" : "false");
  } catch {
    // localStorage may be disabled (privacy mode, quota); UI state still works.
  }
}

/**
 * Lazy-initialized collapsed-state store.
 *
 * Key contracts:
 *  - First sight of a key reads the default from localStorage (active group
 *    forced to false); afterwards the in-memory value wins, no re-read.
 *  - `toggle(key, isActive)` flips and persists (active group writes too —
 *    the UI exposes no toggle for the active group, but the original
 *    behavior is kept as a safety net).
 *
 * Motivation: `useWorkspaceGroups` used to reset the whole collapsed map via
 * `useEffect([groups])` whenever the groups array identity changed, so
 * freshly toggled non-active groups lost their state after a refresh
 * (groups recomputed). Holding this store in a `useRef` with render-time
 * lazy init (O(1) per key after first sight) means groups-identity changes
 * no longer reset state.
 *
 * Pure JS class, React-free, unit-testable directly under node vitest (see
 * the CollapsedStateStore section in
 * `tests/web/workspace-groups-storage.test.ts`).
 */
export class CollapsedStateStore {
  private readonly seen = new Map<string, boolean>();

  /**
   * First access to a key reads the localStorage default (active group is
   * fixed false); later accesses return the in-memory value. Under SSR /
   * privacy-mode the first read is false.
   */
  lookup(key: string, isActive: boolean): boolean {
    const cached = this.seen.get(key);
    if (cached !== undefined) return cached;
    const initial = isActive ? false : loadCollapsed(key);
    this.seen.set(key, initial);
    return initial;
  }

  /**
   * Flip and persist (a single localStorage write; the active group writes
   * too — defensive, since the UI exposes no toggle for it). Returns the
   * new state so React can update the override map.
   */
  toggle(key: string, isActive: boolean): boolean {
    const cur = this.lookup(key, isActive);
    const next = !cur;
    this.seen.set(key, next);
    saveCollapsed(key, next);
    return next;
  }
}
