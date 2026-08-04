import { useEffect, useState, type ReactNode } from "react";
import * as api from "../api/client";
import type { TraceFieldDef } from "../api/types";
import { StateBlock } from "./StateBlock";
import { TraceFilterBar } from "./TraceFilterBar";
import { TraceStatsBar } from "./TraceStatsBar";
import { TraceTable } from "./TraceTable";
import { filterFieldsForRecordType } from "./traceFields";
import { type TraceFilterValues, useTracesData } from "../hooks/useTracesData";

/**
 * Container: fetches the field table once (with retry on failure, see M1)
 * and re-queries the trace rows whenever filters change. Loading / error /
 * empty states funnel through StateBlock; the table + expanded row +
 * filter + stats widgets live in their own files (≤80 lines each).
 */
export function TracePanel() {
  const [fields, setFields] = useState<ReadonlyArray<TraceFieldDef>>([]);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [fieldsReloadKey, setFieldsReloadKey] = useState(0);
  const [filters, setFilters] = useState<TraceFilterValues>({
    conversationId: "",
    recordType: undefined,
    status: undefined,
  });
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { data, loading, error, refresh } = useTracesData(filters);

  useEffect(() => {
    let alive = true;
    api
      .getTraceFields()
      .then((r) => {
        if (alive) setFields(r.fields);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // EXIT: this error surfaces as the "字段表加载失败" block; the retry
        // button bumps fieldsReloadKey, which re-runs this effect — the user
        // leaves the error state by retrying or by switching views (unmount).
        setFieldsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [fieldsReloadKey]);

  const visibleFields = filterFieldsForRecordType(fields, filters.recordType);

  let main: ReactNode;
  if (fieldsError !== null) {
    main = (
      <StateBlock
        kind="error"
        title="字段表加载失败"
        detail={fieldsError}
        onRetry={() => setFieldsReloadKey((n) => n + 1)}
        retryLabel="重试"
      />
    );
  } else if (loading && data === null) {
    main = (
      <StateBlock
        kind="loading"
        title="加载 Trace 记录…"
        detail="读取 JSONL 文件"
      />
    );
  } else if (error !== null && data === null) {
    main = (
      <StateBlock
        kind="error"
        title="Trace 加载失败"
        detail={error}
        onRetry={refresh}
        retryLabel="重试"
      />
    );
  } else if (data !== null) {
    main =
      data.records.length === 0 ? (
        <StateBlock
          kind="empty"
          title="无匹配的 Trace 记录"
          detail="尝试调整过滤条件或点击刷新"
        />
      ) : (
        <TraceTable
          records={data.records}
          fields={visibleFields}
          expandedKey={expandedKey}
          onToggleRow={(k) => setExpandedKey((cur) => (cur === k ? null : k))}
        />
      );
  } else {
    main = null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TraceFilterBar
        values={filters}
        loading={loading}
        fields={fields}
        onChange={setFilters}
        onRefresh={refresh}
      />
      {data !== null ? <TraceStatsBar data={data} /> : null}
      <div className="flex min-h-0 flex-1">{main}</div>
    </div>
  );
}
