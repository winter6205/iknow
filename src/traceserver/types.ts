/**
 * Trace inspection types (read side).
 *
 * The write side lives in src/harness/trace/ and is unchanged: it appends
 * snake_case JSONL rows to a flat file. This module defines the read-side
 * vocabulary so the inspection HTTP surface and the web panel can both
 * speak a typed contract.
 *
 * Architecture note: TraceRecordRow is intentionally a `Record<string, unknown>`
 * — the inspection panel renders raw JSONL as-is. Type narrowing happens at
 * the per-field level via TRACE_FIELD_DEFS in fields.ts.
 */

/**
 * T5: 白名单派生 union — 新 record 类型只在此追加, reader/http/fields 全部
 * 从该白名单联动 (不硬编码 record 名单)。声明顺序被既有消费者依赖, 新成员
 * 只能 APPEND 到末尾。
 */
export type TraceRecordType =
  | "llm_call"
  | "tool_call"
  | "turn"
  | "violation"
  | "session"
  | "sandbox_cmd"
  | "subagent_spawn"
  | "subagent_stop"
  | "subagent_state_change";

export const TRACE_RECORD_TYPES: ReadonlyArray<TraceRecordType> = [
  "llm_call",
  "tool_call",
  "turn",
  "violation",
  "session",
  "sandbox_cmd",
  "subagent_spawn",
  "subagent_stop",
  "subagent_state_change",
];

/** Raw JSONL row, snake_case keys preserved. Read-only to discourage mutation. */
export type TraceRecordRow = Readonly<Record<string, unknown>>;

/** Query parameters for trace inspection. All fields optional; defaults applied in the reader. */
export interface TraceQuery {
  readonly conversationId?: string;
  readonly recordType?: TraceRecordType;
  readonly status?: "ok" | "error";
  /** Row-based pagination offset (limit 1..200, offset >= 0). */
  readonly limit?: number;
  readonly offset?: number;
  /**
   * T5 (#358): 精确匹配 task_id (JSONL 顶层 snake_case key)。
   * undefined = 不参与过滤。Exact-match 只做, 时间窗查询不在本轮 (spec Open Question 1)。
   */
  readonly taskId?: string;
  /**
   * T5 (#358): 精确匹配 parent_turn_id。undefined = 不参与过滤。
   * v1 写侧 SubagentDefinition 尚无 parentTurnId 来源, 该字段当前不落盘;
   * 读侧先就位, spec 升级 child 留位时即可查。
   */
  readonly parentTurnId?: string;
  /**
   * 增量轮询恢复字节偏移 (SC-R 14): 只读文件 resumeOffset 之后的追加行。
   * 与行分页 `offset` 正交 — 行分页是「从第 N 行开始」, 这是「从第 N 字节之后读新增」。
   * 缺省 0 = 从文件头全读。由前端把上一轮响应里的 `offset` 原样传回。
   */
  readonly resumeOffset?: number;
}

export interface TraceQueryResult {
  readonly records: ReadonlyArray<TraceRecordRow>;
  /** Filtered count before pagination — what the UI shows as "total". */
  readonly total: number;
  /** Lines that failed to parse or were not JSON objects. */
  readonly skippedLines: number;
  /** True when the file was truncated by the byte cap. */
  readonly truncated: boolean;
  /**
   * 本次读取结束的字节偏移 (按行边界对齐)。前端下一轮轮询把它作为
   * `resume_offset` 传回, 只拉新增行。0 = 本次读到空文件 / 文件头。
   */
  readonly offset: number;
}

/**
 * Typed error for read-side IO failures (ENOENT is handled silently, not thrown).
 * Bubbles up to http.ts which maps it to 500 internal without leaking the
 * underlying fs message onto the wire.
 */
export class TraceReadError extends Error {
  readonly kind = "io_error";

  constructor(message: string) {
    super(message);
    this.name = "TraceReadError";
  }
}
