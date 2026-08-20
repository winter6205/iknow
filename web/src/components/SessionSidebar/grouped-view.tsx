/**
 * serve-workspace T7a — SessionSidebar 工作空间分组子树。
 *
 * 把原本 prop-drilling 6 层的 GroupedSessionListView → WorkspaceGroupBlock →
 * WorkspaceGroupHeader → GroupCreateButton 折叠为单文件 + Context：所有叶子
 * 通过 `useWorkspaceGroupsCtx()` 取 `groups / onSelect / onToggleCollapsed /
 * onCreateInWorkspace`，prop 链路从 App 到叶子 ≤ 1 层（Context 透传）。
 *
 * 拆分边界（review fix H1 + H2 + M5）：
 *  - `WorkspaceGroupsContext` + `useWorkspaceGroupsCtx`: Context 通道；
 *    叶子只读 useContext，不再接 props。
 *  - `useWorkspaceGroups`: 折叠态自管 hook（localStorage 持久化，纯函数），
 *    由 GroupedView 在 Provider 内一次性调用并下发到 Context。
 *  - `GroupedView`: 顶层 composition。调 useWorkspaceGroups 拿
 *    isCollapsed / toggleCollapsed，下发给 Context；渲染 `<ul>`。
 *  - `WorkspaceGroupBlock` + `WorkspaceGroupHeader` + `GroupCreateButton`:
 *    叶子组件，全部 useContext，不再接 4 个相关 props（currentId 仍走 props
 *    — 它不是工作空间组上下文，且只在叶子用一次）。
 *
 * 行为契约：T4-T6 视觉 / a11y / 折叠逻辑全部不变，spec #90 / #95 不动。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionListItem } from "../../api/types";
import {
  groupSessionsByWorkspace,
  isCurrentSession,
  truncateExcerpt,
  type WorkspaceGroup,
} from "../../lib/session-list";
import { loadCollapsed, saveCollapsed } from "../../lib/workspace-groups";
import { shortId } from "../../lib/format";
import { traceDeepLink } from "../../lib/trace-entry";
import { FOCUS_RING } from "../../lib/ui";
import { plusButtonLabel, shouldShowPlusButton } from "../../lib/sidebar-plus";
import { ChevronDownIcon, PlusIcon } from "./icons";

/** CSS 拼接 helper — 跨组件共用，集中放这里避免重复。 */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Context 通道承载的"组上下文"。叶子 (WorkspaceGroupBlock / Header /
 * GroupCreateButton) 只读 useContext，不再走 props。
 *
 * `groups` / `currentBoundRoot` / `currentConversationId` 由 Provider 在
 * GroupedView 一次性算出，下发到所有叶子；handler 同样集中下发，避免每个
 * 叶子重接 closure。Provider 之外的子组件读 Context 会抛
 * `WorkspaceGroupsContext missing`，让错位用法早崩。
 */
type WorkspaceGroupsContextValue = {
  readonly groups: readonly WorkspaceGroup[];
  readonly currentBoundRoot: string | null;
  readonly currentConversationId: string | null;
  readonly onSelect: (id: string) => void;
  readonly isCollapsed: (groupKey: string) => boolean;
  readonly toggleCollapsed: (groupKey: string) => void;
  readonly onCreateInWorkspace: (root: string) => void;
};

const WorkspaceGroupsContext =
  createContext<WorkspaceGroupsContextValue | null>(null);

export function useWorkspaceGroupsCtx(): WorkspaceGroupsContextValue {
  const v = useContext(WorkspaceGroupsContext);
  if (!v)
    throw new Error(
      "WorkspaceGroupsContext missing — wrap a consumer with <GroupedView>"
    );
  return v;
}

/**
 * 折叠态自管 hook（T4）。仅持久化**非活跃组**（活跃组永远展开，不写盘）。
 * 接受 groups 列表变化时, 自动回收已不存在的组 key(无副作用, 仅内存)。
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

/**
 * GroupCreateButton（T6）— 仅 bound 组渲染；(未绑定) 组由
 * shouldShowPlusButton 过滤。16x16 PlusIcon, text-ink-3 → hover:text-accent。
 * 不再接 onCreate prop — 直接从 Context 拿 `onCreateInWorkspace`。
 */
function GroupCreateButton({ group }: { group: WorkspaceGroup }) {
  const { onCreateInWorkspace } = useWorkspaceGroupsCtx();
  // group.isUnbound 时 group.key 是 sentinel "(未绑定)", 不能 bind —
  // 上层 shouldShowPlusButton 已过滤; 这里再防御一道。
  if (!shouldShowPlusButton(group) || !group.key) return null;
  const title = plusButtonLabel(group.label);
  return (
    <button
      type="button"
      onClick={() => onCreateInWorkspace(group.key)}
      title={title}
      aria-label={title}
      data-workspace-root={group.key}
      className={cx(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-3",
        "transition-colors duration-[160ms] ease-soft hover:text-accent",
        FOCUS_RING
      )}
    >
      <PlusIcon />
    </button>
  );
}

/**
 * WorkspaceGroupHeader（T4 + T6）— 组头。
 *  - 活跃组(isActive)展开且不响应折叠点击 — 渲染静态 div。
 *  - 其它组点击切换折叠态; aria-expanded 同步; chevron 跟随展开方向。
 *  - "📁 basename · 计数" 形态; 活跃组追加 "(当前)" 微标记。
 *  - T6: 右侧追加 + 按钮(bound 组才渲染)。
 *
 * 不再接 collapsed / onToggle / onCreate props — 全部从 Context 拿。
 */
function WorkspaceGroupHeader({ group }: { group: WorkspaceGroup }) {
  const { isCollapsed, toggleCollapsed } = useWorkspaceGroupsCtx();
  // 活跃组永远展开 — 不提供折叠交互。
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
        <GroupCreateButton group={group} />
      </div>
    );
  }
  const collapsed = isCollapsed(group.key);
  const label = `${collapsed ? "展开" : "折叠"} ${group.label} · ${group.sessions.length} 会话`;
  return (
    <div className="flex items-center gap-1 px-3 pt-3 pb-1">
      <button
        type="button"
        onClick={() => toggleCollapsed(group.key)}
        aria-expanded={!collapsed}
        aria-label={label}
        title={
          group.isUnbound
            ? group.label
            : `${group.label} (${group.sessions.length})`
        }
        className={cx(
          // T6: list-style 收紧 — 非活跃组折叠按钮加 rounded-md, 与
          // T5 picker 列表节奏一致; count / chevron / icon 保持原样式。
          "flex flex-1 items-center gap-1.5 rounded-md text-left",
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
      <GroupCreateButton group={group} />
    </div>
  );
}

/**
 * SessionItem — 单条会话 li。仅接 session / currentId / onSelect 三个 prop：
 *  currentId / onSelect 来自 GroupedView（≤ 1 层 prop, 不走 Context — 它们
 *  与"工作空间组"语义无关, 跟会话列表强绑定）。
 */
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
          // serve-workspace T6: list 项 rounded-panel → rounded-md, 与 T5
          // picker 列表收紧节奏一致 (recents / subdirs 都是 rounded-md)。
          // 计数 badge / chevron / active 高亮不在此列 — 用户原话只针对
          // **列表项**, 其它视觉锚点保留现状。
          "flex w-full items-baseline gap-2 truncate rounded-md px-3 py-1.5 pr-8 text-left text-[13px]",
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
 * WorkspaceGroupBlock（T4）— 组头 + session 列表。
 *  collapsed=true 时只渲染组头 (CSS overflow-hidden, 不在 DOM 中移除 li,
 *  让展开是即时的、无 layout flash)。
 *  同一组内 session 仍按 sortSessionsByUpdatedDesc(由 groupSessionsByWorkspace
 *  预先排序)。
 *
 * 仅接 group prop；collapsed / currentId / handlers 全部从 Context 拿。
 */
function WorkspaceGroupBlock({ group }: { group: WorkspaceGroup }) {
  const { currentConversationId, onSelect, isCollapsed } =
    useWorkspaceGroupsCtx();
  // 活跃组永远展开; 其它组按折叠态。
  const collapsed = group.isActive ? false : isCollapsed(group.key);
  return (
    <li className="list-none">
      <WorkspaceGroupHeader group={group} />
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
            currentId={currentConversationId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </li>
  );
}

/**
 * GroupedView（T7a）— 工作空间分组子树顶层 composition。
 *
 * 入参：原始 sessions + currentConversationId + currentBoundRoot + 三个 handler。
 * 内部：useMemo 算 groups；useWorkspaceGroups 拿折叠态；下发到 Context；
 * 渲染 <ul> + 子树。
 *
 * 调用方（SessionSidebar / ExpandedSidebar）只需 5 个 prop（之前 4 个），
 * 内部叶子零 prop drilling。
 */
export function GroupedView({
  sessions,
  currentConversationId,
  currentBoundRoot,
  onSelect,
  onCreateInWorkspace,
}: {
  sessions: readonly SessionListItem[];
  currentConversationId: string | null;
  currentBoundRoot: string | null;
  onSelect: (id: string) => void;
  onCreateInWorkspace: (root: string) => void;
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
  const ctx: WorkspaceGroupsContextValue = {
    groups,
    currentBoundRoot,
    currentConversationId,
    onSelect,
    isCollapsed,
    toggleCollapsed,
    onCreateInWorkspace,
  };
  return (
    <WorkspaceGroupsContext.Provider value={ctx}>
      <ul className="m-0 flex list-none flex-col px-0 pb-3">
        {groups.map((g) => (
          <WorkspaceGroupBlock key={g.key} group={g} />
        ))}
      </ul>
    </WorkspaceGroupsContext.Provider>
  );
}

/**
 * 仅供单测使用的 Provider 注入 helper：让测试可以避开 GroupedView 的
 * `useMemo` + `useWorkspaceGroups` 计算, 直接注入任意 WorkspaceGroups
 * Context 值, 验证叶子组件（Header / Block / GroupCreateButton）能从
 * Context 拿到正确 props。
 */
export function WorkspaceGroupsProvider({
  value,
  children,
}: {
  value: WorkspaceGroupsContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceGroupsContext.Provider value={value}>
      {children}
    </WorkspaceGroupsContext.Provider>
  );
}
