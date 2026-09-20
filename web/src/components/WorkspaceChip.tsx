import type { Ref } from "react";
import { FOCUS_RING } from "../lib/ui";

export type WorkspaceChipProps = {
  /** ws.bound (per-root pick) — fallback state: unbound / root just switched but the session list hasn't refreshed. */
  readonly bound: boolean;
  /** ws.bound current root; coupled with bound. */
  readonly root: string | null;
  /**
   * workspaceRoot of the current active session (from
   * the session-list look-up by currentConversationId). Highest priority —
   * once the user switches into a workspace, the chip shows that session's
   * root name and never degrades to the unbound warning color.
   *
   * Explicitly accepts string | null | undefined: workspaceRoot is a Postel
   * additive field in the backend schema (may be absent in legacy files →
   * undefined); the UI layer treats empty string / undefined alike as
   * "unknown" and falls back.
   */
  readonly activeWorkspaceRoot?: string | null;
  readonly onOpen: () => void;
  /**
   * Parent passes the chip button ref — when the popover
   * closes, focus returns to the trigger (a11y red line: after Esc /
   * outside-click close, focus must land back on the chip).
   */
  readonly buttonRef?: Ref<HTMLButtonElement>;
};

/**
 * POSIX + Windows compatible basename extraction. A root path (empty after
 * trim) returns as-is: showing "/" for a "no basename" input reads better on
 * the chip than an empty string.
 */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  if (trimmed === "") return p;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Top-bar right metadata cluster (chip awareness):
 *
 * Display priority (high → low):
 *  1. `activeWorkspaceRoot` non-empty → that basename + folder icon (folder
 *     color, ink-2, hover highlights ink-3), overall keeping the current-bound shape.
 *     The user has switched into a session inside a workspace, so the chip
 *     reflects that session's root instead of degrading to the unbound warning
 *     color (user feedback: the chip should show the current workspace name
 *     where the session lives).
 *  2. Else `bound && root` → `basename(root)` (same visuals) — fallback while
 *     the picker has not yet got active-session data (e.g. just bound, list not refreshed).
 *  3. Else → warning-colored CTA "选择工作空间" ("choose workspace", unbound).
 *
 * All three states use `<button>`: the chip is both status indicator and picker trigger.
 */
export function WorkspaceChip({
  bound,
  root,
  activeWorkspaceRoot,
  onOpen,
  buttonRef,
}: WorkspaceChipProps) {
  const activeRoot =
    activeWorkspaceRoot && activeWorkspaceRoot.length > 0
      ? activeWorkspaceRoot
      : null;
  const displayRoot = activeRoot ?? (bound && root ? root : null);
  if (displayRoot) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpen}
        title={`工作空间：${displayRoot}`}
        aria-label="工作空间已绑定，点击选择其他"
        className={`flex items-center gap-1.5 rounded-pill border border-ink-3/30 bg-surface px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors duration-200 ease-[var(--ease-soft)] hover:border-ink-3 hover:text-ink ${FOCUS_RING}`}
      >
        <span aria-hidden="true">📁</span>
        <span className="max-w-[10rem] truncate">{basename(displayRoot)}</span>
      </button>
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      title="尚未绑定工作空间"
      aria-label="未绑定工作空间，点击选择"
      className={`flex items-center gap-1.5 rounded-pill border border-warn/40 bg-warn-soft px-2.5 py-1 text-[12px] font-medium text-warn transition-colors duration-200 ease-[var(--ease-soft)] hover:bg-warn hover:text-ink ${FOCUS_RING}`}
    >
      <span aria-hidden="true">⚠</span>
      <span>选择工作空间</span>
    </button>
  );
}
