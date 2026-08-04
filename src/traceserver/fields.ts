/**
 * Trace field declaration table (SSOT for the inspection panel's columns).
 *
 * 新增 trace 字段 = src/harness/trace/types.ts 加类型 + 此表加一行, 面板自动生效。
 *
 * 嵌套字段如 `error` / `messages` 暂不入表 (行展开原始 JSON 可见)。
 *
 * Module-load self-check: `key` and `jsonlKey` must be globally unique.
 * Duplicates throw at import time — this prevents silent column collisions
 * that would only surface in the web table at runtime.
 */
import type { TraceRecordType } from "./types.js";

export interface TraceFieldDef {
  /** Frontend identifier (camelCase). */
  readonly key: string;
  /** JSONL row key (snake_case). The reader returns rows by this key. */
  readonly jsonlKey: string;
  readonly type: "string" | "number" | "boolean" | "enum" | "datetime";
  /** Display label (matches existing UI文案风格, 中英混合). */
  readonly label: string;
  /** Which record_types this column applies to. */
  readonly recordTypes: ReadonlyArray<TraceRecordType>;
  /** Allowed values for enum fields. */
  readonly options?: ReadonlyArray<string>;
  /**
   * Declarative render-tone hint. "status" colours the cell by ok/error value;
   * future fields with ok/error semantics just declare tone here — no renderer
   * change needed (mirrored on web/src/api/types.ts TraceFieldDef).
   */
  readonly tone?: "status";
}

export const TRACE_FIELD_DEFS: ReadonlyArray<TraceFieldDef> = [
  {
    key: "conversationId",
    jsonlKey: "conversation_id",
    type: "string",
    label: "会话 ID",
    recordTypes: ["llm_call", "tool_call", "turn", "violation"],
  },
  {
    key: "recordType",
    jsonlKey: "record_type",
    type: "enum",
    label: "记录类型",
    recordTypes: ["llm_call", "tool_call", "turn", "violation"],
    options: ["llm_call", "tool_call", "turn", "violation"],
  },
  {
    key: "startedAt",
    jsonlKey: "started_at",
    type: "datetime",
    label: "开始时间",
    recordTypes: ["llm_call", "tool_call", "turn"],
  },
  {
    key: "endedAt",
    jsonlKey: "ended_at",
    type: "datetime",
    label: "结束时间",
    recordTypes: ["llm_call", "tool_call", "turn"],
  },
  {
    key: "durationMs",
    jsonlKey: "duration_ms",
    type: "number",
    label: "耗时 (ms)",
    recordTypes: ["llm_call", "tool_call", "turn"],
  },
  {
    key: "status",
    jsonlKey: "status",
    type: "enum",
    label: "状态",
    recordTypes: ["llm_call", "tool_call", "turn"],
    options: ["ok", "error"],
    tone: "status",
  },
  {
    key: "turnIndex",
    jsonlKey: "turn_index",
    type: "number",
    label: "轮次",
    recordTypes: ["turn"],
  },
  {
    key: "decision",
    jsonlKey: "decision",
    type: "enum",
    label: "终止决策",
    recordTypes: ["turn"],
    options: [
      "completed",
      "nonSuccessStop",
      "protocolError",
      "emptyFinalResponse",
      "cancelled",
      "timeout",
    ],
  },
  {
    key: "toolName",
    jsonlKey: "tool_name",
    type: "string",
    label: "工具名",
    recordTypes: ["tool_call"],
  },
  {
    key: "toolKind",
    jsonlKey: "tool_kind",
    type: "enum",
    label: "工具结果",
    recordTypes: ["tool_call"],
    options: ["ok", "validation_failed", "tool_not_found", "execution_failed"],
  },
  {
    key: "supplierStop",
    jsonlKey: "supplier_stop",
    type: "enum",
    label: "供应商终止",
    recordTypes: ["llm_call"],
    options: ["success", "truncation", "refusal", "other"],
  },
  {
    key: "stream",
    jsonlKey: "stream",
    type: "boolean",
    label: "流式",
    recordTypes: ["llm_call"],
  },
  {
    key: "ts",
    jsonlKey: "ts",
    type: "datetime",
    label: "时间",
    recordTypes: ["violation"],
  },
];

// -- module-load self-check ---------------------------------------------------

function assertUniqueFieldDefs(defs: ReadonlyArray<TraceFieldDef>): void {
  const keys = new Set<string>();
  const jsonlKeys = new Set<string>();
  for (const d of defs) {
    if (keys.has(d.key)) {
      throw new Error(`traceserver: duplicate field key "${d.key}"`);
    }
    if (jsonlKeys.has(d.jsonlKey)) {
      throw new Error(`traceserver: duplicate field jsonlKey "${d.jsonlKey}"`);
    }
    keys.add(d.key);
    jsonlKeys.add(d.jsonlKey);
  }
}

assertUniqueFieldDefs(TRACE_FIELD_DEFS);
