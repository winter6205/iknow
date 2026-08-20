import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as api from "../api/client";
import type { SessionListItem } from "../api/types";
import { shortId } from "../lib/format";
import { traceDeepLink } from "../lib/trace-entry";
import {
  groupSessionsByWorkspace,
  isCurrentSession,
  sortSessionsByUpdatedDesc,
  truncateExcerpt,
  type WorkspaceGroup,
} from "../lib/session-list";
import { loadCollapsed, saveCollapsed } from "../lib/workspace-groups";
import { FOCUS_RING } from "../lib/ui";

type SidebarPhase = "loading" | "ready" | "error";

export type SessionSidebarProps = {
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  /**
   * Bump to force the sidebar to re-fetch the session list. App holds the
   * counter and increments after lifecycle events (newSession / createAndAdopt
   * on bootstrap) so the list reflects the current session set without the
   * user having to click refresh.
   */
  refreshSignal?: number;
  /**
   * serve-workspace T4: picker 当前绑定的 workspaceRoot (绝对路径)。
   * 用于组头"当前"标记 (isCurrentRoot)，不参与 sort。
   */
  currentBoundRoot?: string | null;
};

/** Surface any thrown value as a human-readable string. */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SessionListState = {
  phase: SidebarPhase;
  sessions: SessionListItem[];
  errorMsg: string | null;
  refresh: () => void;
};

/**
 * Fetch + cache the session list. `refresh` bumps an internal key that
 * re-runs the effect; an external `externalSignal` (App-owned) also bumps it
 * so lifecycle events (newSession / bootstrap) refresh the list without the
 * user clicking. The AbortController cancels any in-flight request on unmount
 * or re-run so a stale response can never overwrite newer state.
 *
 * #90 contract preserved: listSessions + sortSessionsByUpdatedDesc +
 * error surfacing + refresh bump — only the visual layer changed.
 */
function useSessionList(externalSignal?: number): SessionListState {
  const [phase, setPhase] = useState<SidebarPhase>("loading");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setPhase("loading");
    setErrorMsg(null);
    api.listSessions(ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        setSessions(sortSessionsByUpdatedDesc(res.sessions));
        setPhase("ready");
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setErrorMsg(toMessage(e));
        setPhase("error");
      }
    );
    return () => ctrl.abort();
  }, [reloadKey, externalSignal]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  return { phase, sessions, errorMsg, refresh };
}

/**
 * serve-workspace T4: 自管每个工作空间组的折叠态。
 *  - key = group.key; 仅持久化**非活跃组**(活跃组永远展开, 不写盘)。
 *  - 初始读 localStorage(loadCollapsed 在 SSR / 隐私模式下返回 false)。
 *  - toggle 写回(saveCollapsed 同条件 fail-quiet)。
 *  - 接受 groups 列表变化时, 自动回收已不存在的组 key(无副作用, 仅内存)。
 */
function useWorkspaceGroups(groups: readonly WorkspaceGroup[]): {
  isCollapsed: (groupKey: string) => boolean;
  toggleCollapsed: (groupKey: string) => void;
} {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Re-init when groups change shape (e.g. after a refresh); read once per
  // group from localStorage. New groups not seen before default to false.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const g of groups) {
      next[g.key] = g.isActive ? false : loadCollapsed(g.key);
    }
    setCollapsed(next);
  }, [groups]);
  const toggleCollapsed = useCallback((groupKey: string) => {
    setCollapsed((prev) => {
      const cur = prev[groupKey] ?? false;
      const next = !cur;
      // 仅非活跃组写盘 — 活跃组永远展开, 不浪费 localStorage 槽位。
      saveCollapsed(groupKey, next);
      return { ...prev, [groupKey]: next };
    });
  }, []);
  const isCollapsed = useCallback(
    (groupKey: string) => collapsed[groupKey] ?? false,
    [collapsed]
  );
  return { isCollapsed, toggleCollapsed };
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function PlusIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function LoadingState() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <div
        className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden="true"
      />
      <p className="m-0 text-sm text-ink-2">加载会话列表…</p>
    </div>
  );
}

function ErrorState({
  detail,
  onRetry,
}: {
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      role="alert"
    >
      <p className="m-0 text-sm font-medium text-danger">无法加载会话列表</p>
      <p className="m-0 break-all text-xs text-ink-3">{detail}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cx(
          "mt-1 rounded-pill border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-medium text-accent",
          "transition-colors duration-[160ms] ease-soft hover:border-accent hover:bg-accent hover:text-ink",
          FOCUS_RING
        )}
      >
        重试
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <p className="m-0 text-sm text-ink-2">暂无会话</p>
      <p className="m-0 text-xs text-ink-3">发送消息或点击「新会话」开始。</p>
    </div>
  );
}

function SessionItem({
  session,
  currentId,
  onSelect,
}: {
  session: SessionListItem;
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = isCurrentSession(session.conversation_id, currentId);
  // If the session has no captured final text, fall back to the conversation
  // id prefix rather than the literal "(无消息)" — looks cleaner in the list.
  const excerpt =
    truncateExcerpt(session.lastFinalText, 32) ||
    shortId(session.conversation_id, 8);
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        title={session.conversation_id}
        onClick={() => onSelect(session.conversation_id)}
        className={cx(
          "flex w-full items-baseline gap-2 truncate rounded-panel px-3 py-1.5 pr-8 text-left text-[13px]",
          "transition-colors duration-[160ms] ease-soft",
          active
            ? "bg-accent-soft text-accent font-medium"
            : "text-ink-2 hover:bg-bg hover:text-ink",
          FOCUS_RING
        )}
      >
        <span className="truncate">{excerpt}</span>
      </button>
      {/* ADR-0020 contextual deep-link: hover 浮出，直达该会话的 trace 面板。
          <a> 与 button 同级（a 嵌 button 是非法嵌套）；group-hover/focus 显隐。 */}
      <a
        href={traceDeepLink(session.conversation_id)}
        title={`在 trace 面板查看 ${session.conversation_id}`}
        aria-label={`在 trace 面板查看 ${session.conversation_id}`}
        className={cx(
          "absolute right-1.5 top-1/2 -translate-y-1/2 rounded-pill px-1.5 py-0.5",
          "font-mono text-[10px] text-ink-3 opacity-0",
          "transition-opacity duration-[160ms] ease-soft",
          "group-hover:opacity-100 hover:text-ink focus-visible:opacity-100",
          FOCUS_RING
        )}
      >
        ⇱trace
      </a>
    </li>
  );
}

/**
 * serve-workspace T4: 工作空间组头。
 *  - 活跃组(isActive)展开且不响应折叠点击 — 避免用户把当前会话藏起来。
 *  - 其它组点击切换折叠态; aria-expanded 同步; chevron 跟随展开方向。
 *  - "📁 basename · 计数" 形态; 活跃组追加 "(当前)" 微标记。
 */
function WorkspaceGroupHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: WorkspaceGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // 活跃组永远展开 — 不提供折叠交互 (button + onClick 都不发, 改用 div
  // 静态展示; 但 spec 要求 <button aria-expanded> — 改方案: 渲染 button
  // 但 disabled, 让屏幕阅读器仍能感知到组存在; 视觉上无 chevron / 无 hover)。
  if (group.isActive) {
    return (
      <div
        className="flex items-center gap-2 px-3 pt-3 pb-1"
        aria-label={`${group.label} · ${group.sessions.length} 个会话 (当前活跃)`}
      >
        <span aria-hidden="true" className="text-[11px] text-ink-3">
          📁
        </span>
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">
          {group.label}
        </span>
        <span className="font-mono text-[10px] text-ink-3">
          {group.sessions.length}
        </span>
      </div>
    );
  }
  const label = `${collapsed ? "展开" : "折叠"} ${group.label} · ${group.sessions.length} 会话`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={label}
      title={
        group.isUnbound
          ? group.label
          : `${group.label} (${group.sessions.length})`
      }
      className={cx(
        "flex w-full items-center gap-1.5 px-3 pt-3 pb-1 text-left",
        "transition-colors duration-[160ms] ease-soft hover:bg-bg",
        FOCUS_RING
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "inline-flex h-3 w-3 items-center justify-center text-ink-3 transition-transform duration-[160ms] ease-soft",
          collapsed ? "-rotate-90" : "rotate-0"
        )}
      >
        <ChevronDownIcon />
      </span>
      <span aria-hidden="true" className="text-[11px] text-ink-3">
        {group.isUnbound ? "📂" : "📁"}
      </span>
      <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">
        {group.label}
      </span>
      <span className="font-mono text-[10px] text-ink-3">
        {group.sessions.length}
      </span>
    </button>
  );
}

/**
 * serve-workspace T4: 工作空间组块(组头 + session 列表)。
 *  - collapsed=true 时只渲染组头 (CSS overflow-hidden, 不在 DOM 中移除 li,
 *    让展开是即时的、无 layout flash)。
 *  - 同一组内 session 仍按 sortSessionsByUpdatedDesc(由 groupSessionsByWorkspace
 *    预先排序)。
 */
function WorkspaceGroupBlock({
  group,
  currentId,
  onSelect,
  isCollapsed,
  onToggleCollapsed,
}: {
  group: WorkspaceGroup;
  currentId: string | null;
  onSelect: (id: string) => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  // 活跃组永远展开; 其它组按折叠态。
  const collapsed = group.isActive ? false : isCollapsed;
  return (
    <li className="list-none">
      <WorkspaceGroupHeader
        group={group}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      <ul
        className={cx(
          "m-0 flex list-none flex-col gap-1 px-3 pb-2",
          collapsed && "hidden"
        )}
        aria-hidden={collapsed}
      >
        {group.sessions.map((s) => (
          <SessionItem
            key={s.conversation_id}
            session={s}
            currentId={currentId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </li>
  );
}

/**
 * serve-workspace T4: 顶层分组列表视图。
 *  - 接 SessionSidebar 的 sessions, 用 groupSessionsByWorkspace 切组。
 *  - 接 useWorkspaceGroups 自管折叠态(localStorage 持久化)。
 *  - EmptyState 仍由父组件 ExpandedSidebar 负责(空列表不分组)。
 */
function GroupedSessionListView({
  sessions,
  currentConversationId,
  currentBoundRoot,
  onSelect,
}: {
  sessions: readonly SessionListItem[];
  currentConversationId: string | null;
  currentBoundRoot: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(
    () =>
      groupSessionsByWorkspace(
        sessions,
        currentConversationId,
        currentBoundRoot
      ),
    [sessions, currentConversationId, currentBoundRoot]
  );
  const { isCollapsed, toggleCollapsed } = useWorkspaceGroups(groups);
  return (
    <ul className="m-0 flex list-none flex-col px-0 pb-3">
      {groups.map((g) => (
        <WorkspaceGroupBlock
          key={g.key}
          group={g}
          currentId={currentConversationId}
          onSelect={onSelect}
          isCollapsed={isCollapsed(g.key)}
          onToggleCollapsed={() => toggleCollapsed(g.key)}
        />
      ))}
    </ul>
  );
}

type ExpandedSidebarData = {
  phase: SidebarPhase;
  sessions: SessionListItem[];
  errorMsg: string | null;
  refresh: () => void;
  currentConversationId: string | null;
  currentBoundRoot: string | null;
};

type ExpandedSidebarHandlers = {
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onToggleCollapsed: () => void;
};

function ExpandedSidebar({
  data,
  handlers,
  collapseBtnRef,
}: {
  data: ExpandedSidebarData;
  handlers: ExpandedSidebarHandlers;
  collapseBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  const {
    phase,
    sessions,
    errorMsg,
    refresh,
    currentConversationId,
    currentBoundRoot,
  } = data;
  const { onSelect, onNewSession, onToggleCollapsed } = handlers;
  return (
    <div className="flex h-full w-72 shrink-0 animate-fade-in flex-col">
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

      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {phase === "loading" ? (
          <LoadingState />
        ) : phase === "error" ? (
          <ErrorState detail={errorMsg ?? "未知错误"} onRetry={refresh} />
        ) : sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <GroupedSessionListView
            sessions={sessions}
            currentConversationId={currentConversationId}
            currentBoundRoot={currentBoundRoot}
            onSelect={onSelect}
          />
        )}
      </div>
    </div>
  );
}

function CollapsedRail({
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
        <ChevronRightIcon />
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

export function SessionSidebar({
  currentConversationId,
  onSelect,
  collapsed,
  onToggleCollapsed,
  onNewSession,
  refreshSignal,
  currentBoundRoot = null,
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
            currentBoundRoot,
          }}
          handlers={{ onSelect, onNewSession, onToggleCollapsed }}
          collapseBtnRef={collapseBtnRef}
        />
      )}
    </aside>
  );
}
