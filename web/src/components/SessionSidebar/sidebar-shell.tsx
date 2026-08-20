/**
 * serve-workspace T7a — SessionSidebar 的 UI chrome 子组件 (T7b review fix 落地)。
 *
 * 抽出 `SidebarHeader` / `NewSessionCTA` / `ExpandedSidebar` / `CollapsedRail`
 * 四个 layout 子组件。它们与 useSessionList 解耦（只接 phase / refresh /
 * handlers 等 props），合起来撑起"展开/折叠"两态外壳，让 SessionSidebar.tsx
 * 收敛到 orchestration（≤ 300 行）。
 *
 * T7b review fix:
 *  - M2: `ExpandedSidebarData.currentBoundRoot` 字段移除 — 该字段从未被任
 *    何消费者读取（Speculative Generality）。GroupedView 不再接收该 prop。
 *  - L3: ChevronRightIcon → ChevronIcon({ direction: "right" }).
 */
import type { RefObject } from "react";
import { FOCUS_RING } from "../../lib/ui";
import type { SessionListItem } from "../../api/types";
import type { SessionListPhase } from "../../hooks/use-session-list";
import { GroupedView } from "./grouped-view";
import { EmptyState, ErrorState, LoadingState } from "./sidebar-states";
import { ChevronIcon, ChevronLeftIcon, PlusIcon, RefreshIcon } from "./icons";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Sidebar 顶部 header：标题 + refresh + collapse toggle。 */
function SidebarHeader({
  refresh,
  collapseBtnRef,
  onToggleCollapsed,
}: {
  refresh: () => void;
  collapseBtnRef: RefObject<HTMLButtonElement | null>;
  onToggleCollapsed: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 px-3 pt-3">
      <h2 className="m-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">
        会话
      </h2>
      <button
        type="button"
        onClick={refresh}
        title="刷新列表"
        aria-label="刷新列表"
        className={cx(
          "flex h-7 w-7 items-center justify-center rounded-pill text-ink-3",
          "transition-colors duration-[160ms] ease-soft hover:bg-bg hover:text-ink",
          FOCUS_RING
        )}
      >
        <RefreshIcon />
      </button>
      <button
        ref={collapseBtnRef}
        type="button"
        onClick={onToggleCollapsed}
        title="收起侧栏"
        aria-label="收起侧栏"
        aria-expanded={true}
        className={cx(
          "flex h-7 w-7 items-center justify-center rounded-pill text-ink-3",
          "transition-colors duration-[160ms] ease-soft hover:bg-bg hover:text-ink",
          FOCUS_RING
        )}
      >
        <ChevronLeftIcon />
      </button>
    </header>
  );
}

/** 「新会话」CTA pill：accent 主按钮。 */
function NewSessionCTA({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="shrink-0 px-3 pt-2">
      <button
        type="button"
        onClick={onNewSession}
        className={cx(
          "group flex w-full items-center justify-center gap-2 rounded-pill bg-accent px-4 py-2.5",
          "text-sm font-semibold text-ink shadow-bubble",
          "transition-[transform,box-shadow] duration-[160ms] ease-soft",
          "hover:-translate-y-px hover:shadow-chip active:scale-[0.97]",
          FOCUS_RING
        )}
      >
        <PlusIcon />
        <span>新会话</span>
      </button>
    </div>
  );
}

type ExpandedSidebarData = {
  phase: SessionListPhase;
  sessions: ReadonlyArray<SessionListItem>;
  errorMsg: string | null;
  refresh: () => void;
  currentConversationId: string | null;
};

type ExpandedSidebarHandlers = {
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onToggleCollapsed: () => void;
  onCreateInWorkspace: (root: string) => void;
};

/**
 * ExpandedSidebar composition（M5 fix）：
 *  - SidebarHeader (refresh + collapse toggle)
 *  - NewSessionCTA
 *  - content routing (loading / error / empty / grouped)
 *
 * Phase / error / empty 三态留本组件（与 useSessionList 紧密耦合，不到 30 行）。
 *
 * T7b review fix M2: `data.currentBoundRoot` 移除（GroupedView 不再需要）。
 */
export function ExpandedSidebar({
  data,
  handlers,
  collapseBtnRef,
}: {
  data: ExpandedSidebarData;
  handlers: ExpandedSidebarHandlers;
  collapseBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  const { phase, sessions, errorMsg, refresh, currentConversationId } = data;
  const { onSelect, onNewSession, onToggleCollapsed, onCreateInWorkspace } =
    handlers;
  return (
    <div className="flex h-full w-72 shrink-0 animate-fade-in flex-col">
      <SidebarHeader
        refresh={refresh}
        collapseBtnRef={collapseBtnRef}
        onToggleCollapsed={onToggleCollapsed}
      />
      <NewSessionCTA onNewSession={onNewSession} />
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {phase === "loading" ? (
          <LoadingState />
        ) : phase === "error" ? (
          <ErrorState detail={errorMsg ?? "未知错误"} onRetry={refresh} />
        ) : sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <GroupedView
            sessions={sessions}
            currentConversationId={currentConversationId}
            onSelect={onSelect}
            onCreateInWorkspace={onCreateInWorkspace}
          />
        )}
      </div>
    </div>
  );
}

export function CollapsedRail({
  onToggleCollapsed,
  expandBtnRef,
}: {
  onToggleCollapsed: () => void;
  expandBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex h-full w-14 shrink-0 animate-fade-in flex-col items-center gap-3 py-3">
      <button
        ref={expandBtnRef}
        type="button"
        onClick={onToggleCollapsed}
        title="展开侧栏"
        aria-label="展开侧栏"
        aria-expanded={false}
        className={cx(
          "flex h-9 w-9 items-center justify-center rounded-pill text-ink-2",
          "transition-colors duration-[160ms] ease-soft hover:bg-bg hover:text-ink",
          FOCUS_RING
        )}
      >
        <ChevronIcon direction="right" />
      </button>
      <span
        aria-hidden="true"
        className="mt-1 select-none text-[10px] font-semibold uppercase tracking-[0.22em] text-ink-3 [writing-mode:vertical-rl]"
      >
        会话
      </span>
    </div>
  );
}
