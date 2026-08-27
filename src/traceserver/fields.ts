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

/**
 * T5 (#358) subagent 生命周期列。
 * jsonlKey 对齐 src/harness/trace/types.ts 三类 Subagent*Record + jsonl.ts
 * camelToSnake: subagent_id 是显式 id 载体 (= manager taskId), task_id /
 * parent_turn_id / from_state / to_state / final_state / exit_code 来自顶层
 * camelCase key 的 snake 化。Postel: 可选字段 (parent_turn_id 等) 仅存在时
 * 落盘, 列定义按 schema 声明不受写入侧缺席影响。
 *
 * 三类 record 共用列 (subagentId / taskId / origin / parentTurnId / startedAt /
 * status / ts) 直接列全三 type; 单类列 (fromState / toState / finalState) 只列
 * 对应 type。
 */
const SUBAGENT_TYPES: ReadonlyArray<TraceRecordType> = [
  "subagent_spawn",
  "subagent_stop",
  "subagent_state_change",
] as const;

/**
 * subagent_step 的关联列 (taskId / origin / parentTurnId) 与前三类同列, 但 id
 * 列不同: step 的 id 载体是 subagent_step_id, 故 subagentId 列刻意只挂
 * SUBAGENT_TYPES —— 见 src/harness/trace/types.ts SubagentStepRecord 注释。
 */
const SUBAGENT_TYPES_WITH_STEP: ReadonlyArray<TraceRecordType> = [
  ...SUBAGENT_TYPES,
  "subagent_step",
] as const;

const SUBAGENT_STEP_PHASE_OPTIONS: ReadonlyArray<string> = [
  "dispatch",
  "settle",
] as const;

const SUBAGENT_STOP_REASON_OPTIONS: ReadonlyArray<string> = [
  "crashed",
  "maxTurnsExceeded",
  "timeout",
  "protocolError",
  "cancelled",
] as const;

const SUBAGENT_STATE_OPTIONS: ReadonlyArray<string> = [
  "starting",
  "running",
  "completed",
  "failed",
] as const;

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
    recordTypes: [
      "llm_call",
      "tool_call",
      "turn",
      "violation",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
    options: [
      "llm_call",
      "tool_call",
      "turn",
      "violation",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
  },
  {
    key: "startedAt",
    jsonlKey: "started_at",
    type: "datetime",
    label: "开始时间",
    recordTypes: [
      "llm_call",
      "tool_call",
      "turn",
      "session",
      "sandbox_cmd",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
  },
  {
    key: "endedAt",
    jsonlKey: "ended_at",
    type: "datetime",
    label: "结束时间",
    recordTypes: [
      "llm_call",
      "tool_call",
      "turn",
      "session",
      "sandbox_cmd",
      "subagent_stop",
      "subagent_step",
    ],
  },
  {
    key: "durationMs",
    jsonlKey: "duration_ms",
    type: "number",
    label: "耗时 (ms)",
    recordTypes: [
      "llm_call",
      "tool_call",
      "turn",
      "session",
      "sandbox_cmd",
      "subagent_stop",
      "subagent_step",
    ],
  },
  {
    key: "status",
    jsonlKey: "status",
    type: "enum",
    label: "状态",
    recordTypes: [
      "llm_call",
      "tool_call",
      "turn",
      "session",
      "sandbox_cmd",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
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
    recordTypes: [
      "violation",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
  },
  {
    key: "agentVersion",
    jsonlKey: "agent_version",
    type: "string",
    label: "Agent 版本",
    recordTypes: ["session"],
  },
  {
    key: "parentTurnId",
    jsonlKey: "parent_turn_id",
    type: "string",
    label: "父回合 ID",
    recordTypes: [
      "sandbox_cmd",
      "subagent_spawn",
      "subagent_stop",
      "subagent_state_change",
      "subagent_step",
    ],
  },
  {
    key: "command",
    jsonlKey: "command",
    type: "string",
    label: "命令",
    recordTypes: ["sandbox_cmd"],
  },
  {
    key: "exitCode",
    jsonlKey: "exit_code",
    type: "number",
    label: "退出码",
    recordTypes: ["sandbox_cmd", "subagent_stop"],
  },
  {
    key: "stdoutCaptured",
    jsonlKey: "stdout_captured",
    type: "boolean",
    label: "捕获输出",
    recordTypes: ["sandbox_cmd"],
  },
  {
    key: "stdout",
    jsonlKey: "stdout",
    type: "string",
    label: "标准输出",
    recordTypes: ["sandbox_cmd"],
  },
  {
    key: "subagentId",
    jsonlKey: "subagent_id",
    type: "string",
    label: "子代理 ID",
    recordTypes: SUBAGENT_TYPES,
  },
  {
    key: "taskId",
    jsonlKey: "task_id",
    type: "string",
    label: "任务 ID",
    recordTypes: SUBAGENT_TYPES_WITH_STEP,
  },
  {
    key: "origin",
    jsonlKey: "origin",
    type: "enum",
    label: "来源",
    recordTypes: SUBAGENT_TYPES_WITH_STEP,
    options: ["parent", "child"],
  },
  {
    key: "subagentStepId",
    jsonlKey: "subagent_step_id",
    type: "string",
    label: "步骤 ID",
    recordTypes: ["subagent_step"],
  },
  {
    key: "stepIndex",
    jsonlKey: "step_index",
    type: "number",
    label: "步序",
    recordTypes: ["subagent_step"],
  },
  {
    key: "phase",
    jsonlKey: "phase",
    type: "enum",
    label: "阶段",
    recordTypes: ["subagent_step"],
    options: SUBAGENT_STEP_PHASE_OPTIONS,
  },
  {
    key: "label",
    jsonlKey: "label",
    type: "string",
    label: "步骤名",
    recordTypes: ["subagent_step"],
  },
  {
    key: "finalState",
    jsonlKey: "final_state",
    type: "enum",
    label: "终态",
    recordTypes: ["subagent_stop"],
    options: ["completed", "failed"],
  },
  {
    key: "reason",
    jsonlKey: "reason",
    type: "enum",
    label: "原因",
    recordTypes: ["subagent_stop", "subagent_state_change"],
    options: SUBAGENT_STOP_REASON_OPTIONS,
  },
  {
    key: "fromState",
    jsonlKey: "from_state",
    type: "enum",
    label: "原状态",
    recordTypes: ["subagent_state_change"],
    options: SUBAGENT_STATE_OPTIONS,
  },
  {
    key: "toState",
    jsonlKey: "to_state",
    type: "enum",
    label: "新状态",
    recordTypes: ["subagent_state_change"],
    options: SUBAGENT_STATE_OPTIONS,
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
