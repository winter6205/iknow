/**
 * serve-workspace T8 — `useSessionList` 从 SessionSidebar 内部 hook 提到
 * 共享 hook, 让 App 层也能用同一份 session list (lookup active session 的
 * workspaceRoot, 喂给 WorkspaceChip 实现上下文感知)。
 *
 * 行为契约: 与原 SessionSidebar 内 inline `useSessionList` 100% 等价 — 同样
 * 的 listSessions + AbortController + 外部 refreshSignal bump + 错误降级。
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { SessionListItem } from "../api/types";

export type SessionListPhase = "loading" | "ready" | "error";

export type SessionListState = {
  readonly phase: SessionListPhase;
  readonly sessions: ReadonlyArray<SessionListItem>;
  readonly errorMsg: string | null;
  readonly refresh: () => void;
};

/** Surface any thrown value as a human-readable string. */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
export function useSessionList(externalSignal?: number): SessionListState {
  const [phase, setPhase] = useState<SessionListPhase>("loading");
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
        // 排序由 GroupedView 内的 groupSessionsByWorkspace 接管；
        // 这里只负责把 raw sessions 暴露给上层。
        setSessions(res.sessions);
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
