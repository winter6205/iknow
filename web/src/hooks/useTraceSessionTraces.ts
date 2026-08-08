/**
 * FlowTree 数据 hook — owns the per-session trace fetch + polling for the
 * FlowTree view. Fetches the full session file (limit 200) and projects the
 * records into `TraceEvent[]` for the tree layout (see lib/flowTree.ts).
 *
 * Polling: when `pollMs > 0` an interval re-queries every pollMs. `?poll=0`
 * disables polling (one-shot load). The last successful response is kept
 * during a refresh so the tree does not flash an empty canvas.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../api/client";
import type { TracesResponse } from "../api/types";
import { SessionApiError } from "../api/types";
import { recordsToEvents, type TraceEvent } from "../lib/flowTree";

export type TraceSessionTracesState = {
  /** Projected events for the tree; null until the first response arrives. */
  readonly events: TraceEvent[] | null;
  readonly records: TracesResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  /** Effective poll interval (0 = polling disabled). */
  readonly pollMs: number;
};

function messageOf(err: unknown): string {
  return err instanceof SessionApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);
}

export function useTraceSessionTraces(
  sessionId: string | null,
  pollMs: number
): TraceSessionTracesState {
  const [records, setRecords] = useState<TracesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    if (!sessionId) {
      setRecords(null);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getTraces({
        conversation_id: sessionId,
        limit: 200,
        poll: pollMs,
      })
      .then((res) => {
        if (alive) {
          setRecords(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(messageOf(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, reloadKey, pollMs]);

  // Incremental polling for the current session (SC-V 26).
  useEffect(() => {
    if (!sessionId || pollMs <= 0) return;
    const t = setInterval(() => setReloadKey((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [sessionId, pollMs]);

  const events = useMemo<TraceEvent[] | null>(
    () => (records ? recordsToEvents(records.records) : null),
    [records]
  );

  return { events, records, loading, error, refresh, pollMs };
}
