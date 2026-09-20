/**
 * Hoist `useSessionList` out of SessionSidebar into a
 * shared hook so the App layer can use the same session list (looking up the
 * active session's workspaceRoot for a context-aware WorkspaceChip).
 *
 * Behavioral contract: 100% equivalent to the original inline hook in
 * SessionSidebar — same listSessions + AbortController + external
 * refreshSignal bump + error degradation.
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
 * Contract preserved: listSessions + sortSessionsByUpdatedDesc +
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
        // Ordering is owned by groupSessionsByWorkspace inside GroupedView;
        // this layer only exposes the raw sessions upward.
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
