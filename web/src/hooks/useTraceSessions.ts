/**
 * Trace session list hook — fetches `GET /api/v1/sessions` once on mount with a
 * retry key. The list is refreshed on demand via `refresh()` (the sidebar
 * refresh button) or whenever the mount key changes.
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { TraceSessionSummary } from "../api/types";
import { SessionApiError } from "../api/types";

export type TraceSessionsState = {
  readonly sessions: ReadonlyArray<TraceSessionSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useTraceSessions(): TraceSessionsState {
  const [sessions, setSessions] = useState<ReadonlyArray<TraceSessionSummary>>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getTraceSessions()
      .then((res) => {
        if (alive) {
          setSessions(res.sessions);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg =
          err instanceof SessionApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return { sessions, loading, error, refresh };
}
