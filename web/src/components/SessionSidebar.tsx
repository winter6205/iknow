/**
 * SessionSidebar orchestrator.
 *
 * History: this file was 777 lines with 6-level prop drilling, excessive
 * length, and a long ExpandedSidebar method. Extracted:
 *  - useWorkspaceGroups + WorkspaceGroupHeader / WorkspaceGroupBlock /
 *    GroupCreateButton / GroupedSessionListView → `grouped-view.tsx` + Context.
 *  - Icons (PlusIcon / RefreshIcon / ChevronLeftIcon / ChevronIcon) → `icons.tsx`.
 *  - Tri-state display (LoadingState / ErrorState / EmptyState) → `sidebar-states.tsx`.
 *  - SidebarHeader / NewSessionCTA / ExpandedSidebar / CollapsedRail →
 *    `sidebar-shell.tsx`.
 *
 * `useSessionList` lifted from this file to
 * `web/src/hooks/use-session-list.ts` so App can share the same session list
 * (looking up the active session's workspaceRoot for WorkspaceChip).
 *
 * What remains here is orchestration only (collapse toggle, focus management,
 * useSessionList, subcomponent prop wiring).
 */
import { useEffect, useRef } from "react";
import { useSessionList } from "../hooks/use-session-list";
import { CollapsedRail, ExpandedSidebar } from "./SessionSidebar/sidebar-shell";

export type SessionSidebarProps = {
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  /**
   * Callback for the workspace-group header "+" button —
   * create a new session inside the given workspace. The App layer binds the
   * root to the picker (if needed), then calls chat.newSession. The (未绑定)
   * ("unbound") group renders no "+" button, so this callback never fires for it.
   */
  onCreateInWorkspace: (root: string) => void;
  /**
   * Bump to force the sidebar to re-fetch the session list. App holds the
   * counter and increments after lifecycle events (newSession / createAndAdopt
   * on bootstrap) so the list reflects the current session set without the
   * user having to click refresh.
   */
  refreshSignal?: number;
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function SessionSidebar({
  currentConversationId,
  onSelect,
  collapsed,
  onToggleCollapsed,
  onNewSession,
  onCreateInWorkspace,
  refreshSignal,
}: SessionSidebarProps) {
  const { phase, sessions, errorMsg, refresh } = useSessionList(refreshSignal);
  const collapseBtnRef = useRef<HTMLButtonElement>(null);
  const expandBtnRef = useRef<HTMLButtonElement>(null);

  // Focus management: when the sidebar toggles, move keyboard focus to the
  // toggle button in the now-visible state. Skip the first effect run so the
  // narrow-screen auto-collapse at mount doesn't steal focus.
  const focusManaged = useRef(false);
  useEffect(() => {
    if (!focusManaged.current) {
      focusManaged.current = true;
      return;
    }
    if (collapsed) {
      expandBtnRef.current?.focus();
    } else {
      collapseBtnRef.current?.focus();
    }
  }, [collapsed]);

  return (
    <aside
      aria-label="会话列表"
      className={cx(
        "h-full shrink-0 overflow-hidden border-r border-line bg-surface",
        "transition-[width] duration-[220ms] ease-soft",
        collapsed ? "w-14" : "w-72"
      )}
    >
      {collapsed ? (
        <CollapsedRail
          onToggleCollapsed={onToggleCollapsed}
          expandBtnRef={expandBtnRef}
        />
      ) : (
        <ExpandedSidebar
          data={{
            phase,
            sessions,
            errorMsg,
            refresh,
            currentConversationId,
          }}
          handlers={{
            onSelect,
            onNewSession,
            onToggleCollapsed,
            onCreateInWorkspace,
          }}
          collapseBtnRef={collapseBtnRef}
        />
      )}
    </aside>
  );
}
