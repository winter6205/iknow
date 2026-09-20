/**
 * LoopTrace layer A: records structural metadata only, strictly no payloads
 * (input/output live in the authoritative messages store). Reduced once from
 * turns at run end — a pure function.
 *
 * The field set is locked (SSOT): no new fields here; extensions go through
 * a new spec amendment.
 *
 * Gate note: this file is the type-only shape layer; every
 * timeout/trace/signal/cancel identifier here is an SSOT field-name
 * placeholder and implements no gated capability behavior (the capability
 * gate is satisfied constructively, no exemption needed — see
 * public-exports.test.ts); behavior lives in other modules per their own
 * specs, explicitly deferred.
 */

/** Cancellation source, four values (replacing the old timeoutHit / signalAborted boolean pair). Value domain aligned with the race outcome's `source` (adapter → none). */
export type CancelKind = "none" | "callerAbort" | "timerTimeout" | "hostCancel";

export interface TurnTrace {
  readonly turnIndex: number;
  /** References AssistantTurnResult.supplierStop's value domain, not redefined here. */
  readonly supplierStop: "success" | "truncation" | "refusal" | "other";
  readonly toolCalls: ReadonlyArray<{
    readonly toolUseId: string;
    readonly toolName: string;
    /** References ToolExecutionResult.kind's value domain, not redefined here. */
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    readonly message?: string;
  }>;
  /** Wall-clock from step entry to exit. */
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
 * Reduce once from turns at run end (pure function, not incremental
 * accumulation). nesting ≤ 2: a single reduce + counter adds.
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
