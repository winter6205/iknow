/**
 * FlowTree domain helpers (web side).
 *
 * Ported from the trace-prototype (`data/types.ts`) and adapted to project the
 * real JSONL trace records returned by `GET /api/v1/traces` into the same
 * `TraceEvent` shape the FlowTree layout consumes. The prototype used a hard
 * coded `EVENTS` array; here `recordsToEvents` derives events from wire rows.
 *
 * The tree shows 7 stations (session/llm/tool/sandbox/permission/violation/
 * subagent); each record_type maps to a station, and the multi-turn layout is
 * recovered by walking the records chronologically (llm/tool rows carry no
 * turn_index — the `turn` row that follows them carries it).
 */

import type { TraceRecord, TraceRecordType } from "../api/types";

export type StationId =
  | "session"
  | "llm"
  | "tool"
  | "sandbox"
  | "permission"
  | "violation"
  | "subagent";

export type EventStatus = "ok" | "warn" | "denied" | "error";

export interface TraceEvent {
  /** Position in the full sequence (0-based) — layout anchor for the tree. */
  idx: number;
  /** Owning turn (0-based). Recovered from the `turn` rows. */
  turn: number;
  /** Owning station. */
  station: StationId;
  /** Event status (UI 4-value derivative of the wire 2-value status). */
  status: EventStatus;
  /** Display title. */
  label: string;
  /** Duration in ms. */
  durationMs: number;
  /** Detail-panel keyvals (payload fields, structural keys stripped). */
  fields: Record<string, string | number | boolean | null>;
  /** Up/down-stream ids (prototype detail panel; currently unused). */
  upstream?: string;
  downstream?: string;
}

export const STATIONS: { id: StationId; label: string }[] = [
  { id: "session", label: "会话" },
  { id: "llm", label: "LLM" },
  { id: "tool", label: "工具" },
  { id: "sandbox", label: "沙箱" },
  { id: "permission", label: "权限" },
  { id: "violation", label: "异常" },
  { id: "subagent", label: "子代理" },
];

export const fmtDur = (ms: number): string =>
  ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";

export const statusTone = (s: EventStatus): "ok" | "warn" | "danger" =>
  s === "ok" ? "ok" : s === "warn" ? "warn" : "danger";

export const isErr = (s: EventStatus): boolean =>
  s === "error" || s === "denied";

// -- record projection --------------------------------------------------------

function str(record: TraceRecord, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function num(record: TraceRecord, key: string): number {
  const v = record[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function timeOf(record: TraceRecord): string {
  const startedAt = str(record, "started_at");
  if (startedAt && startedAt.length > 0) return startedAt;
  const ts = str(record, "ts");
  return ts ?? "";
}

/**
 * Map a JSONL record to its FlowTree station. `permission` reuses the
 * `violation` record_type (spec #286: reason=permission_denied lands on
 * permission); everything else is a direct record_type → station mapping.
 */
function stationOf(
  recordType: TraceRecordType,
  record: TraceRecord
): StationId {
  switch (recordType) {
    case "session":
      return "session";
    case "llm_call":
      return "llm";
    case "tool_call":
      return "tool";
    case "sandbox_cmd":
      return "sandbox";
    case "turn":
      // 回合标记落在会话站（原型：回合分组挂在 session 站下）。
      return "session";
    case "subagent_spawn":
    case "subagent_stop":
    case "subagent_state_change":
    case "subagent_step":
      return "subagent";
    case "violation": {
      const decision = str(record, "decision") ?? "";
      const reason = str(record, "reason") ?? String(record["detail"] ?? "");
      if (decision === "deny" || /permission|deny|denied/i.test(reason)) {
        return "permission";
      }
      return "violation";
    }
    default:
      return "violation";
  }
}

/** Derive the UI 4-value status from the wire status + station context. */
function statusOf(
  recordType: TraceRecordType,
  record: TraceRecord,
  station: StationId
): EventStatus {
  if (station === "permission") return "denied";
  const s = str(record, "status");
  if (s === "error") return "error";
  if (s === "denied") return "denied";
  if (s === "warn") return "warn";
  // Tool failures surface as tool_kind != ok even when status is absent.
  if (recordType === "tool_call") {
    const kind = str(record, "tool_kind");
    if (kind !== undefined && kind !== "ok") return "error";
  }
  // Subagent 终态 / 状态迁移失败即使 wire status 缺省也标红：stop 落 failed
  // 或 state_change 迁到 failed 都是失败终局（T4 写侧 status 可被 safeTrace
  // 包裹后在终态路由保留 reason，这里以状态域为准不依赖 status 填写）。
  if (station === "subagent") {
    if (str(record, "final_state") === "failed") return "error";
    if (
      str(record, "to_state") === "failed" &&
      recordType === "subagent_state_change"
    ) {
      return "error";
    }
  }
  return "ok";
}

function labelOf(recordType: TraceRecordType, record: TraceRecord): string {
  switch (recordType) {
    case "session":
      return "会话 启动";
    case "llm_call": {
      const model =
        str(record, "model_actual") ?? str(record, "model_requested");
      return model ? `LLM · ${model}` : "LLM 调用";
    }
    case "tool_call":
      return str(record, "tool_name") ?? "工具调用";
    case "sandbox_cmd":
      return str(record, "command") ?? "沙箱命令";
    case "subagent_spawn":
      // task_preview 截断后的任务摘要在服务端已截断, 直接展示 (权限行)。
      return str(record, "task_preview") ?? "子代理 spawn";
    case "subagent_stop": {
      const finalState = str(record, "final_state");
      return finalState ? `子代理 stop · ${finalState}` : "子代理 stop";
    }
    case "subagent_state_change": {
      const fromState = str(record, "from_state") ?? "?";
      const toState = str(record, "to_state") ?? "?";
      return `子代理状态 ${fromState}→${toState}`;
    }
    case "subagent_step": {
      // step_index 是 0-based, 展示 1-based 与「回合 N」标签保持一致。
      const head = `子代理步骤 ${num(record, "step_index") + 1} · ${
        str(record, "phase") ?? "?"
      }`;
      const stepLabel = str(record, "label");
      return stepLabel ? `${head} · ${stepLabel}` : head;
    }
    case "turn":
      return `回合 ${num(record, "turn_index") + 1}`;
    case "violation": {
      const reason = str(record, "reason") ?? str(record, "message");
      return reason ? `违规 · ${reason}` : "违规";
    }
    default:
      return recordType;
  }
}

/** Structural keys stripped from the detail-panel fields (payload kept). */
const STRUCTURAL_KEYS = new Set([
  "conversation_id",
  "record_type",
  "session_id",
  "llm_call_id",
  "tool_call_id",
  "turn_id",
  "sandbox_cmd_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "status",
  "turn_index",
  // Subagent 生命周期列 (T4/T5): 承载 id / 关联 / 状态机迁移的键剥离出详情区 —
  // 这些键在列定义 (TRACE_FIELD_DEFS) 里各有独立列, 重复展示无信息增益。
  // 保留 reason / summary / task_preview 等 payload 细节。
  "subagent_id",
  "task_id",
  "parent_turn_id",
  "origin",
  "final_state",
  "from_state",
  "to_state",
  "exit_code",
  "signal",
  "ts",
  // subagent_step 列: id 载体 + 步序 / 阶段 / 步骤名都已进标签与列定义。
  "subagent_step_id",
  "step_index",
  "phase",
  "label",
]);

function fieldsOf(
  record: TraceRecord
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(record)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] =
      typeof v === "object" && v !== null
        ? JSON.stringify(v)
        : (v as string | number | boolean | null);
  }
  return out;
}

/**
 * Project raw JSONL records (as returned by `GET /api/v1/traces`, time-ordered
 * by the reader as descending) into a chronological `TraceEvent[]` for FlowTree.
 *
 * Turn assignment is a two-pass walk:
 *   1. Build `llmCallId -> turnIndex` from `turn` rows (they carry both
 *      turn_index and the llm_call_ids that belong to that turn).
 *   2. Walk records chronologically: llm_call rows resolve their turn via the
 *      map; tool_call rows resolve via parent_llm_call_id; other rows fall back
 *      to the last-seen turn (session root → 0). This is correct because a turn
 *      row's started_at precedes its llm/tool rows (the turn covers the whole
 *      turn), so it is not a reliable "advance" marker.
 */
export function recordsToEvents(
  records: ReadonlyArray<TraceRecord>
): TraceEvent[] {
  const chronological = [...records].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta === tb) return 0;
    if (ta === "") return 1;
    if (tb === "") return -1;
    return ta < tb ? -1 : 1;
  });

  // Pass 1: llm_call_id -> turn_index (turn rows declare the association).
  const turnOfLlmCall = new Map<string, number>();
  for (const record of chronological) {
    if (record["record_type"] !== "turn") continue;
    const turnIndex = num(record, "turn_index");
    const ids = record["llm_call_ids"];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string") turnOfLlmCall.set(id, turnIndex);
      }
    }
  }

  // Pass 2: chronological walk with a last-seen fallback turn.
  const events: TraceEvent[] = [];
  let currentTurn = 0;
  for (const record of chronological) {
    const recordType = (record["record_type"] as TraceRecordType) ?? "turn";
    let turn = currentTurn;
    if (recordType === "llm_call") {
      const id = str(record, "llm_call_id");
      if (id !== undefined && turnOfLlmCall.has(id)) {
        turn = turnOfLlmCall.get(id)!;
      }
    } else if (recordType === "tool_call") {
      const parentId = str(record, "parent_llm_call_id");
      if (parentId !== undefined && turnOfLlmCall.has(parentId)) {
        turn = turnOfLlmCall.get(parentId)!;
      }
    } else if (recordType === "turn") {
      const ti = num(record, "turn_index");
      turn = ti;
      currentTurn = ti + 1;
    }
    const station = stationOf(recordType, record);
    events.push({
      idx: events.length,
      turn,
      station,
      status: statusOf(recordType, record, station),
      label: labelOf(recordType, record),
      durationMs: num(record, "duration_ms"),
      fields: fieldsOf(record),
    });
  }
  return events;
}
