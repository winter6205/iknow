/**
 * SessionSidebar workspace-group subtree.
 *
 * Collapses the former 6-level prop-drilling chain
 * GroupedSessionListView → WorkspaceGroupBlock → WorkspaceGroupHeader →
 * GroupCreateButton into one file + Context: every leaf reads
 * `groups / onSelect / onToggleCollapsed / onCreateInWorkspace` via
 * `useWorkspaceGroupsCtx()`, so the prop chain from App to leaf is ≤ 1 level
 * (Context carries the rest).
 *
 * Split boundaries:
 *  - `WorkspaceGroupsContext` + `useWorkspaceGroupsCtx`: the Context channel;
 *    leaves only read useContext, no props.
 *  - `useWorkspaceGroups`: self-managed collapse-state hook (rewritten as lazy
 *    per-key init — `CollapsedStateStore` caches in a
 *    useRef so a changing `groups` array reference no longer resets state via
 *    useEffect([groups])), called once inside the Provider by GroupedView and
 *    pushed into Context.
 *  - `GroupedView`: top-level composition. Calls useWorkspaceGroups for
 *    isCollapsed / toggleCollapsed, pushes into Context; renders `<ul>`.
 *  - `WorkspaceGroupBlock` + `WorkspaceGroupHeader` + `GroupCreateButton`:
 *    leaf components, all useContext, no longer accepting the 4 related props
 *    (currentId still arrives via props — it is not group context and each
 *    leaf uses it once).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionListItem } from "../../api/types";
import {
  groupSessionsByWorkspace,
  isCurrentSession,
  sidebarLineText,
  type WorkspaceGroup,
} from "../../lib/session-list";
import { CollapsedStateStore } from "../../lib/workspace-groups";
import { traceDeepLink } from "../../lib/trace-entry";
import { FOCUS_RING } from "../../lib/ui";
import { plusButtonLabel, shouldShowPlusButton } from "../../lib/sidebar-plus";
import { ChevronIcon, PlusIcon } from "./icons";

/** CSS join helper — shared across components here to avoid duplication. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * The "group context" carried by the Context channel. Leaves
 * (WorkspaceGroupBlock / Header / GroupCreateButton) only read useContext, no props.
 *
 * `groups` / `currentConversationId` are computed once by the Provider in
 * GroupedView and pushed to all leaves; handlers are centrally provided too,
 * so leaves do not rewire closures. Reading the Context outside the Provider
 * throws `WorkspaceGroupsContext missing` so misplacement crashes early.
 *
 * `currentBoundRoot` field removed — groupSessionsByWorkspace
 * no longer takes that param, so the Context need not carry it.
 */
type WorkspaceGroupsContextValue = {
  readonly groups: readonly WorkspaceGroup[];
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
 * Self-managed collapse-state hook (lazy-init rewrite).
 *
 * The old `useEffect([groups])` re-read the whole map from localStorage
 * whenever the groups array reference changed (sessions update /
 * currentConversationId change retriggering useMemo), wiping the user's fresh
 * toggles.
 *
 * New design:
 *  - `CollapsedStateStore` holds a `Map<key, boolean>` persisted across mount
 *    via useRef: the first `lookup` reads localStorage, afterwards the in-memory
 *    value wins.
 *  - User toggles write React `overrides` state (one setState), kept in sync
 *    with the store's memory value — `isCollapsed` reads overrides first,
 *    falling back to the store.
 *  - A changing groups reference no longer resets any state: the store Map is
 *    persistent and render never touches localStorage.
 */
function useWorkspaceGroups(groups: readonly WorkspaceGroup[]): {
  isCollapsed: (groupKey: string) => boolean;
  toggleCollapsed: (groupKey: string) => void;
} {
  const storeRef = useRef<CollapsedStateStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new CollapsedStateStore();
  }
  const store = storeRef.current;
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Derived key → isActive lookup (recomputed each render — O(n), groups is usually small).
  // useMemo pins the reference so isCollapsed/toggleCollapsed callbacks are not
  // rebuilt on unrelated renders.
  const isActiveMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const g of groups) m[g.key] = g.isActive;
    return m;
  }, [groups]);

  const isCollapsed = useCallback(
    (groupKey: string): boolean => {
      const ov = overrides[groupKey];
      if (ov !== undefined) return ov;
      return store.lookup(groupKey, isActiveMap[groupKey] ?? false);
    },
    [overrides, isActiveMap, store]
  );

  const toggleCollapsed = useCallback(
    (groupKey: string): void => {
      const isActive = isActiveMap[groupKey] ?? false;
      const next = store.toggle(groupKey, isActive);
      setOverrides((prev) => ({ ...prev, [groupKey]: next }));
    },
    [isActiveMap, store]
  );

  return { isCollapsed, toggleCollapsed };
}

/**
 * GroupCreateButton — rendered for bound groups only; the (未绑定)
 * ("unbound") group is filtered by shouldShowPlusButton. 16x16 PlusIcon,
 * text-ink-3 → hover:text-accent. No longer takes an onCreate prop —
 * reads `onCreateInWorkspace` straight from Context.
 */
function GroupCreateButton({ group }: { group: WorkspaceGroup }) {
  const { onCreateInWorkspace } = useWorkspaceGroupsCtx();
  // When group.isUnbound, group.key is the sentinel "(未绑定)" ("unbound")
  // and must not be bound — the upper shouldShowPlusButton already filters;
  // this is a second line of defense.
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
 * WorkspaceGroupHeader — group header row.
 *  - Active group (isActive) stays expanded and ignores collapse clicks — renders a static div.
 *  - Other groups toggle collapse on click; aria-expanded stays in sync; chevron follows the expand direction.
 *  - Shape: "📁 basename · count"; active group appends a "(当前)" ("current") micro-marker.
 *  - Plus button on the right (bound groups only).
 *
 * No longer takes collapsed / onToggle / onCreate props — all from Context.
 *
 * ChevronDownIcon → ChevronIcon({ direction }); the collapsed
 * state uses `direction="down"` + parent `rotate-0` / `-rotate-90` to switch.
 */
function WorkspaceGroupHeader({ group }: { group: WorkspaceGroup }) {
  const { isCollapsed, toggleCollapsed } = useWorkspaceGroupsCtx();
  // Active group is always expanded — no collapse affordance.
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
          // List-style tightening — inactive-group collapse button gets
          // rounded-md to match the picker list rhythm; count / chevron /
          // icon keep their original styling.
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
          <ChevronIcon direction="down" />
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
 * SessionItem — one session li. Takes only session / currentId / onSelect:
 *  currentId / onSelect come from GroupedView (≤ 1 prop level, not via
 *  Context — they have nothing to do with "workspace group" semantics and
 *  bind tightly to the session list).
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
  // Main line = header title (when empty/absent, sidebarLineText falls back to the
  // id-prefix empty state — never to lastFinalText; spec session-list-title).
  const excerpt = sidebarLineText(session);
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        title={session.conversation_id}
        onClick={() => onSelect(session.conversation_id)}
        className={cx(
          // List items rounded-panel → rounded-md to match the picker
          // tightening (recents / subdirs are all rounded-md).
          // Count badge / chevron / active highlight are out of scope — the
          // user's ask targeted **list items** only; other visual anchors stay.
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
      {/* ADR-0020 contextual deep-link: revealed on hover, goes straight to this
          session's trace panel. <a> is a sibling of the button (a-in-button is
          invalid nesting); shown via group-hover/focus. */}
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
 * WorkspaceGroupBlock — group header + session list.
 *  collapsed=true renders only the header (CSS hides the list; li stays in the
 *  DOM so expanding is instant with no layout flash).
 *  Sessions within a group keep sortSessionsByUpdatedDesc order (pre-sorted by
 *  groupSessionsByWorkspace).
 *
 * Takes only the group prop; collapsed / currentId / handlers all come from Context.
 */
function WorkspaceGroupBlock({ group }: { group: WorkspaceGroup }) {
  const { currentConversationId, onSelect, isCollapsed } =
    useWorkspaceGroupsCtx();
  // Active group is always expanded; others follow collapse state.
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
 * GroupedView — top-level composition of the workspace-group subtree.
 *
 * Inputs: raw sessions + currentConversationId + two handlers.
 * Internally: useMemo computes groups; useWorkspaceGroups supplies collapse
 * state; both are pushed into Context; renders <ul> + subtree.
 *
 * No longer takes `currentBoundRoot` (dead).
 *
 * Callers (SessionSidebar / ExpandedSidebar) pass only 4 props (was 5);
 * inner leaves have zero prop drilling.
 */
export function GroupedView({
  sessions,
  currentConversationId,
  onSelect,
  onCreateInWorkspace,
}: {
  sessions: readonly SessionListItem[];
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  onCreateInWorkspace: (root: string) => void;
}) {
  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, currentConversationId),
    [sessions, currentConversationId]
  );
  const { isCollapsed, toggleCollapsed } = useWorkspaceGroups(groups);
  const ctx: WorkspaceGroupsContextValue = {
    groups,
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
 * Provider-injection helper for unit tests only: lets tests bypass GroupedView's
 * `useMemo` + `useWorkspaceGroups` computation and inject an arbitrary
 * WorkspaceGroups Context value directly, verifying that leaf components
 * (Header / Block / GroupCreateButton) read the right props from Context.
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
