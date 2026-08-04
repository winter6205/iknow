/**
 * Trace panel data hook — owns the filter inputs and the GET /api/v1/traces
 * fetch effect. Returns ready-to-render shape; TracePanel only composes UI.
 *
 * Auto-fetch: every change to any filter or `reloadKey` triggers a re-query.
 * `refresh()` is the user-driven reload entrypoint.
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type {
  TraceQueryParams,
  TraceRecordType,
  TracesResponse,
} from "../api/types";
import { SessionApiError } from "../api/types";

export type TraceFilterValues = {
  conversationId: string;
  recordType: TraceRecordType | undefined;
  status: "ok" | "error" | undefined;
};

export type TraceDataState = {
  readonly data: TracesResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
};

export function useTracesData(filters: TraceFilterValues): TraceDataState {
  const [data, setData] = useState<TracesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const trimmed = filters.conversationId.trim();
    const params: TraceQueryParams = {
      limit: 100,
      ...(trimmed !== "" ? { conversation_id: trimmed } : {}),
      ...(filters.recordType !== undefined
        ? { record_type: filters.recordType }
        : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    };
    api
      .getTraces(params)
      .then((res) => {
        if (alive) {
          setData(res);
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
  }, [filters.conversationId, filters.recordType, filters.status, reloadKey]);

  return { data, loading, error, refresh };
}
