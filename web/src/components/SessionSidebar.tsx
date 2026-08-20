/**
 * serve-workspace T7a — SessionSidebar orchestrator (review fix slimming)。
 *
 * 历史：该文件原 777 行，prop drilling 6 层（H1）、超长（H2）、ExpandedSidebar
 * 长方法（M5）。T7a 把：
 *  - useWorkspaceGroups + WorkspaceGroupHeader / WorkspaceGroupBlock /
 *    GroupCreateButton / GroupedSessionListView 抽到 `grouped-view.tsx` + Context。
 *  - 图标 (PlusIcon / RefreshIcon / ChevronLeftIcon / ChevronIcon)
 *    抽到 `icons.tsx`。
 *  - 三态展示 (LoadingState / ErrorState / EmptyState) 抽到 `sidebar-states.tsx`。
 *  - SidebarHeader / NewSessionCTA / ExpandedSidebar / CollapsedRail 抽到
 *    `sidebar-shell.tsx`。
 *
 * T8: `useSessionList` 从本文件提到 `web/src/hooks/use-session-list.ts`,
 * 让 App 也能用同一份 session list (lookup active session 的 workspaceRoot
 * 喂给 WorkspaceChip)。
 *
 * 本文件只保留 orchestration（collapsed 切换、focus 管理、useSessionList、
 * 子组件 prop 装配）。T4-T6 行为契约不变。
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
   * serve-workspace T6: 工作空间组头部"+"按钮的回调 — 在指定 workspace
   * 内新建会话。App 层负责把 root 绑到 picker (若需要), 再调 chat.newSession。
   * (未绑定) 组不渲染 + 按钮, 此回调不会被调用。
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
