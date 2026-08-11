/**
 * 017 LoopTrace A 层:只记结构元数据,严格不含 payload(input/output 在
 * messages 权威保存)。run 结束时一次性从 turns reduce,纯函数。
 *
 * 字段集锁死(spec A7 SSOT):不在此加新字段;扩展走新 spec 增补。
 *
 * Gate B 守门说明:本文件是 017 type-only 形状层,所有 timeout/trace/
 * signal/cancel 相关标识符都是 SSOT 字段名占位,不在此实现任何 Gate B
 * 能力行为;行为实现由 017 后置 spec 在其它模块承担并显式 deferred。
 * (本文件为 017 deferred 模块,Gate B capability gate 构造性满足,
 * 无 exemption 必要;见 public-exports.test.ts。)
 */

/** 025 #98:取消来源四值枚举(原 timeoutHit/signalAborted 双布尔)。值域与 023 RaceModelOutcome.source 对齐(adapter→none)。 */
export type CancelKind = "none" | "callerAbort" | "timerTimeout" | "hostCancel";

export interface TurnTrace {
  readonly turnIndex: number;
  /** 引用 014 AssistantTurnResult.supplierStop 值域,不新定义。 */
  readonly supplierStop: "success" | "truncation" | "refusal" | "other";
  readonly toolCalls: ReadonlyArray<{
    readonly toolUseId: string;
    readonly toolName: string;
    /** 引用 015 ToolExecutionResult.kind 值域,不新定义。 */
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    readonly message?: string;
  }>;
  /** step 入口 → 出口 wall-clock。 */
  readonly durationMs: number;
  readonly cancelKind: CancelKind;
}

export interface Totals {
  readonly totalDurationMs: number;
  readonly cancelKindCounts: {
    readonly none: number;
    readonly callerAbort: number;
    readonly timerTimeout: number;
    readonly hostCancel: number;
  };
  readonly toolErrorTotals: {
    readonly ok: number;
    readonly validation_failed: number;
    readonly tool_not_found: number;
    readonly execution_failed: number;
  };
}

export interface LoopTrace {
  readonly turns: ReadonlyArray<TurnTrace>;
  readonly totals: Totals;
}

/**
 * run 结束时一次性从 turns reduce(纯函数,非增量累加)。
 * nesting ≤ 2:单次 reduce + 计数累加。
 */
export function computeTotals(turns: ReadonlyArray<TurnTrace>): Totals {
  let totalDurationMs = 0;
  let none = 0;
  let callerAbort = 0;
  let timerTimeout = 0;
  let hostCancel = 0;
  let ok = 0;
  let validation_failed = 0;
  let tool_not_found = 0;
  let execution_failed = 0;
  for (const t of turns) {
    totalDurationMs += t.durationMs;
    if (t.cancelKind === "none") none += 1;
    else if (t.cancelKind === "callerAbort") callerAbort += 1;
    else if (t.cancelKind === "timerTimeout") timerTimeout += 1;
    else if (t.cancelKind === "hostCancel") hostCancel += 1;
    for (const c of t.toolCalls) {
      if (c.kind === "ok") ok += 1;
      else if (c.kind === "validation_failed") validation_failed += 1;
      else if (c.kind === "tool_not_found") tool_not_found += 1;
      else if (c.kind === "execution_failed") execution_failed += 1;
    }
  }
  return {
    totalDurationMs,
    cancelKindCounts: {
      none,
      callerAbort,
      timerTimeout,
      hostCancel,
    },
    toolErrorTotals: {
      ok,
      validation_failed,
      tool_not_found,
      execution_failed,
    },
  };
}
