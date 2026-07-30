import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { SessionListItem } from "../api/types";
import { shortId } from "../lib/format";
import {
  isCurrentSession,
  sortSessionsByUpdatedDesc,
  truncateExcerpt,
} from "../lib/session-list";
import styles from "./SessionSidebar.module.css";

type SidebarPhase = "loading" | "ready" | "error";

export type SessionSidebarProps = {
  currentConversationId: string | null;
  onSelect: (id: string) => void;
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

function SidebarHead({ onRefresh }: { onRefresh: () => void }) {
  return (
    <header className={styles.head}>
      <span className={styles.headTitle}>会话</span>
      <button
        type="button"
        className={styles.refresh}
        onClick={onRefresh}
        title="刷新列表"
      >
        刷新
      </button>
    </header>
  );
}

function LoadingState() {
  return (
    <div className={styles.state} role="status" aria-live="polite">
      <div className={styles.spinner} aria-hidden="true" />
      <p className={styles.stateText}>加载会话列表…</p>
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
    <div className={styles.state} role="alert">
      <p className={styles.stateText}>无法加载会话列表</p>
      <p className={styles.stateDetail}>{detail}</p>
      <button type="button" className={styles.retry} onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className={styles.state}>
      <p className={styles.stateText}>暂无会话</p>
      <p className={styles.stateHint}>发送消息或点击「新会话」开始。</p>
    </div>
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
    <ul className={styles.list}>
      {sessions.map((s) => {
        const active = isCurrentSession(s.conversation_id, currentId);
        const excerpt = truncateExcerpt(s.lastFinalText, 80) || "（无消息）";
        return (
          <li key={s.conversation_id}>
            <button
              type="button"
              className={
                active ? `${styles.item} ${styles.active}` : styles.item
              }
              aria-current={active ? "true" : undefined}
              title={s.conversation_id}
              onClick={() => onSelect(s.conversation_id)}
            >
              <span className={styles.itemId}>
                {shortId(s.conversation_id, 10)}
              </span>
              <span className={styles.itemExcerpt}>{excerpt}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SessionSidebar({
  currentConversationId,
  onSelect,
}: SessionSidebarProps) {
  const { phase, sessions, errorMsg, refresh } = useSessionList();

  return (
    <aside className={styles.sidebar} aria-label="会话列表">
      <SidebarHead onRefresh={refresh} />
      <div className={styles.body}>
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
    </aside>
  );
}
