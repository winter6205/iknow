import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as api from "../api/client";
import type { SessionListItem } from "../api/types";
import { shortId } from "../lib/format";
import {
  isCurrentSession,
  sortSessionsByUpdatedDesc,
  truncateExcerpt,
} from "../lib/session-list";
import { FOCUS_RING } from "../lib/ui";

type SidebarPhase = "loading" | "ready" | "error";

export type SessionSidebarProps = {
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
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
 * Fetch + cache the session list. `refresh` bumps a key that re-runs the
 * effect; the AbortController cancels any in-flight request on unmount or
 * re-run so a stale response can never overwrite newer state.
 *
 * #90 contract preserved: listSessions + sortSessionsByUpdatedDesc +
 * error surfacing + refresh bump — only the visual layer changed.
 */
function useSessionList(): SessionListState {
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
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  return { phase, sessions, errorMsg, refresh };
}

/** Compact timestamp: HH:MM when same calendar day, MM-DD otherwise. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
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
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
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
      strokeWidth={2}
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
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
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
          "transition-colors duration-[160ms] ease-soft hover:border-accent hover:bg-accent hover:text-surface",
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
  const excerpt = truncateExcerpt(session.lastFinalText, 80) || "（无消息）";
  const when = formatWhen(session.updatedAt);
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        title={session.conversation_id}
        onClick={() => onSelect(session.conversation_id)}
        className={cx(
          "group flex w-full flex-col gap-1 rounded-panel border-l-2 px-3 py-2 text-left",
          "transition-colors duration-[160ms] ease-soft",
          active
            ? "border-l-accent bg-accent-soft"
            : "border-l-transparent text-ink-2 hover:bg-bg hover:text-ink",
          FOCUS_RING
        )}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cx(
              "truncate font-mono text-[11px]",
              active ? "text-accent" : "text-ink-3"
            )}
          >
            {shortId(session.conversation_id, 10)}
          </span>
          {when ? (
            <span
              className={cx(
                "shrink-0 font-mono text-[10px]",
                active ? "text-accent/80" : "text-ink-3"
              )}
            >
              {when}
            </span>
          ) : null}
        </span>
        <span
          className={cx(
            "line-clamp-2 break-words text-sm leading-snug",
            active ? "text-ink" : "text-ink-2"
          )}
        >
          {excerpt}
        </span>
      </button>
    </li>
  );
}

function SessionListView({
  sessions,
  currentId,
  onSelect,
}: {
  sessions: SessionListItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 px-3 pb-3">
      {sessions.map((s) => (
        <SessionItem
          key={s.conversation_id}
          session={s}
          currentId={currentId}
          onSelect={onSelect}
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
  const { phase, sessions, errorMsg, refresh, currentConversationId } = data;
  const { onSelect, onNewSession, onToggleCollapsed } = handlers;
  return (
    <div className="flex h-full w-80 shrink-0 animate-fade-in flex-col">
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
            "text-sm font-semibold text-surface shadow-bubble",
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
          <SessionListView
            sessions={sessions}
            currentId={currentConversationId}
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
}: SessionSidebarProps) {
  const { phase, sessions, errorMsg, refresh } = useSessionList();
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
        collapsed ? "w-14" : "w-80"
      )}
    >
      {collapsed ? (
        <CollapsedRail
          onToggleCollapsed={onToggleCollapsed}
          expandBtnRef={expandBtnRef}
        />
      ) : (
        <ExpandedSidebar
          data={{ phase, sessions, errorMsg, refresh, currentConversationId }}
          handlers={{ onSelect, onNewSession, onToggleCollapsed }}
          collapseBtnRef={collapseBtnRef}
        />
      )}
    </aside>
  );
}
