/**
 * Domain errors raised by the shared read-side cores (`query_trace`,
 * `list_sessions`, `get_record`).
 *
 * Messages carry no tool name: this core backs several tools on each thin face,
 * so naming one would misreport the others. Prefixing belongs to the faces.
 *
 * spec SC20 counts the kinds: `validation` / `record_scan` / `record_not_found`
 * / `window_overflow` / `session_not_found` — five, plus the pre-existing
 * `io_error` on `TraceReadError` (types.ts). Out-of-range coordinates answer
 * `validation` with the real number of addressable items rather than growing a
 * sixth kind.
 */

/**
 * 读侧共用的校验错误，三条轴都抛它（`query_trace` 的 limit / detail，
 * `list_sessions` 的 limit / offset，`get_record` 的窗坐标与越界的
 * `message_index` / `part_index`）：ACI 薄皮的 catch arm 按 `instanceof` 认它，
 * spec SC20 按 `kind` 计数，所以两张皮共用一份、不各立一个同形类。
 * 类名里的 `QueryTrace` 是历史名，重命名另开票（plan `trace-mcp-read-side-split`
 * §待写入），不在本轮中途改判别名的字符串面。
 */
export class TraceQueryValidationError extends Error {
  override readonly name = "TraceQueryValidationError";
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export class TraceQueryRecordScanError extends Error {
  override readonly name = "TraceQueryRecordScanError";
  readonly kind = "record_scan" as const;
  readonly recordId: string;
  readonly scanned: number;

  constructor(recordId: string, scanned: number) {
    super(
      `record_id scan exhausted after ${scanned} records before finding '${recordId}'`
    );
    this.recordId = recordId;
    this.scanned = scanned;
  }
}

/**
 * `record_id` 扫完了整个会话仍无命中。与 `record_scan` 是两件事：那条说「没扫
 * 完」，这条说「扫完了，没有」。`get_record` 抛它取代行轴现状的静默
 * `records: []`（plan T6 AC）。
 */
export class TraceRecordNotFoundError extends Error {
  override readonly name = "TraceRecordNotFoundError";
  readonly kind = "record_not_found" as const;
  readonly recordId: string;

  constructor(recordId: string) {
    super(`no record matched record_id '${recordId}'`);
    this.recordId = recordId;
  }
}

/**
 * 必填 `conversation_id` 在该 traceDir 下没有对应文件。它**不等于**
 * `record_not_found`：那条记录可能存在，只是本面根本没去看（第 14 条把它从 T7
 * 前移到 T6，因为 `get_record` 是第一个 `conversation_id` 必填的面）。
 */
export class TraceSessionNotFoundError extends Error {
  override readonly name = "TraceSessionNotFoundError";
  readonly kind = "session_not_found" as const;
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`no trace session file for conversation_id '${conversationId}'`);
    this.conversationId = conversationId;
  }
}

/**
 * 调用方给的窗越出了该 part 末尾（`from_char + count > part_chars`）。
 *
 * 消息带 `part_chars` 与剩余量、**不回传任何 part 字节**：判据是「窗必须整个落在
 * part 内」（第 14 条），所以这里的正确回答是「你这么改坐标就能读全」，不是「顺手
 * 给你一页截好的」——后者正是本 kind 存在的理由被自己推翻。`remaining` 让调用方一次
 * 就能算出末页的 `count`。
 */
export class TraceWindowOverflowError extends Error {
  override readonly name = "TraceWindowOverflowError";
  readonly kind = "window_overflow" as const;
  readonly fromChar: number;
  readonly count: number;
  readonly partChars: number;
  readonly remaining: number;

  constructor(coords: { fromChar: number; count: number; partChars: number }) {
    const remaining = Math.max(0, coords.partChars - coords.fromChar);
    super(
      `window of ${coords.count} characters at from_char=${coords.fromChar} ` +
        `exceeds the part: part_chars=${coords.partChars}, remaining=${remaining}`
    );
    this.fromChar = coords.fromChar;
    this.count = coords.count;
    this.partChars = coords.partChars;
    this.remaining = remaining;
  }
}
