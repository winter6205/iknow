import { useEffect, useState, type ReactNode } from "react";
import * as api from "../api/client";
import type { TraceFieldDef } from "../api/types";
import { StateBlock } from "./StateBlock";
import { TraceFilterBar } from "./TraceFilterBar";
import { TraceStatsBar } from "./TraceStatsBar";
import { TraceTable } from "./TraceTable";
import { filterFieldsForRecordType } from "./traceFields";
import { type TraceFilterValues, useTracesData } from "../hooks/useTracesData";
import { useTraceSessions } from "../hooks/useTraceSessions";
import { useTraceSessionTraces } from "../hooks/useTraceSessionTraces";
import { FlowTree } from "./FlowTree";
import { FlowNodeDetail } from "./FlowNodeDetail";
import { TraceSessionList } from "./TraceSessionList";
import { TraceViewToggle, type TraceView } from "./TraceViewToggle";

/**
 * 读取 `?poll=<ms>` 参数（缺省 1000，0 关闭轮询）。spec v2 SC-V 26。
 * 非正整数 → 回退默认 1000（后端 400 由 hook 错误态呈现，这里保持前端稳健）。
 */
function readPollMs(): number {
  const raw = new URL(window.location.href).searchParams.get("poll");
  if (raw === null || raw === "") return 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1000;
}

/**
 * Container: 会话列表（左）→ 下钻到 FlowTree（主视图）/ TraceTable（表格
 * 变体，spec Open Q5）+ 右侧详情面板。字段表加载一次（失败可重试）；
 * FlowTree 数据按当前会话轮询（useTraceSessionTraces）。
 */
export function TracePanel() {
  const [fields, setFields] = useState<ReadonlyArray<TraceFieldDef>>([]);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [fieldsReloadKey, setFieldsReloadKey] = useState(0);
  const [view, setView] = useState<TraceView>("flow");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    refresh: refreshSessions,
  } = useTraceSessions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const pollMs = readPollMs();
  const { events, loading, error, refresh } = useTraceSessionTraces(
    sessionId,
    pollMs
  );

  // 字段表 + 现有 TraceTable 过滤状态（表格变体复用）
  const [filters, setFilters] = useState<TraceFilterValues>({
    conversationId: "",
    recordType: undefined,
    status: undefined,
  });
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { data: tableData } = useTracesData(filters);

  useEffect(() => {
    let alive = true;
    api
      .getTraceFields()
      .then((r) => {
        if (alive) setFields(r.fields);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setFieldsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [fieldsReloadKey]);

  // 会话列表就绪后默认选中最近会话（mtime 最新，SC-V 23）。
  useEffect(() => {
    if (sessionId !== null) return;
    if (sessions.length === 0) return;
    const latest = [...sessions].sort((a, b) => b.mtime - a.mtime)[0];
    setSessionId(latest.conversation_id);
  }, [sessions, sessionId]);

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
  } else if (view === "flow") {
    if (loading && events === null) {
      main = (
        <StateBlock
          kind="loading"
          title="加载 Trace 记录…"
          detail="读取 JSONL 文件"
        />
      );
    } else if (error !== null && events === null) {
      main = (
        <StateBlock
          kind="error"
          title="Trace 加载失败"
          detail={error}
          onRetry={refresh}
          retryLabel="重试"
        />
      );
    } else if (events !== null && events.length === 0) {
      main = (
        <StateBlock
          kind="empty"
          title="无 Trace 记录"
          detail="该会话暂无事件，或调整会话列表后点击刷新"
        />
      );
    } else if (events !== null) {
      main = (
        <div className="flex min-h-0 flex-1">
          <div className="tp-canvas flex-1">
            <div className="tp-canvas-inner">
              <FlowTree
                events={events}
                selectedIdx={selectedIdx}
                onSelect={setSelectedIdx}
              />
            </div>
          </div>
          <FlowNodeDetail
            event={selectedIdx === null ? null : (events[selectedIdx] ?? null)}
          />
        </div>
      );
    } else {
      main = null;
    }
  } else {
    // 表格变体（原 TracePanel 行为）
    if (loading && tableData === null) {
      main = (
        <StateBlock
          kind="loading"
          title="加载 Trace 记录…"
          detail="读取 JSONL 文件"
        />
      );
    } else if (error !== null && tableData === null) {
      main = (
        <StateBlock
          kind="error"
          title="Trace 加载失败"
          detail={error}
          onRetry={refresh}
          retryLabel="重试"
        />
      );
    } else if (tableData !== null) {
      main =
        tableData.records.length === 0 ? (
          <StateBlock
            kind="empty"
            title="无匹配的 Trace 记录"
            detail="尝试调整过滤条件或点击刷新"
          />
        ) : (
          <TraceTable
            records={tableData.records}
            fields={visibleFields}
            expandedKey={expandedKey}
            onToggleRow={(k) => setExpandedKey((cur) => (cur === k ? null : k))}
          />
        );
    } else {
      main = null;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <TraceViewToggle value={view} onChange={setView} />
        <span className="text-[11px] text-ink-3">
          {view === "flow" && sessionId !== null ? (
            <span className="font-mono">{sessionId.slice(0, 13)}…</span>
          ) : (
            "全部记录"
          )}
          {view === "flow" && pollMs > 0 ? (
            <span className="ml-2 text-ok">轮询 {pollMs}ms</span>
          ) : null}
          {view === "flow" && pollMs === 0 ? (
            <span className="ml-2">一次性加载</span>
          ) : null}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <TraceSessionList
          sessions={sessions}
          selectedId={sessionId}
          loading={sessionsLoading}
          error={sessionsError}
          onSelect={(id) => {
            setSessionId(id);
            setSelectedIdx(null);
          }}
          onRefresh={refreshSessions}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {view === "table" ? (
            <>
              <TraceFilterBar
                values={filters}
                loading={loading}
                fields={fields}
                onChange={setFilters}
                onRefresh={refresh}
              />
              {tableData !== null ? <TraceStatsBar data={tableData} /> : null}
            </>
          ) : null}
          <div className="flex min-h-0 flex-1">{main}</div>
        </div>
      </div>
    </div>
  );
}
