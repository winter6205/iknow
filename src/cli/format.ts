/**
 * CLI 投影层:把 harness `RunResult` + `LoopTrace` 渲成两种形态。
 *
 * 旧版 `formatAnswerHuman` / `formatAnswerJson` 已被 Session API 持续消费;
 * 本文件 fork 自旧实现并切换到 harness Foundation `RunResult` + `LoopTrace`
 * (014 / 017 SSOT 形状),CLI 路径走本投影层。
 *
 * 设计要点:
 * - `formatRunHuman` 总是渲染状态行(即便 finalText 为 null),便于脚本消费者从
 *   stderr 看到 stopReason / turns / 工具链 / 总耗时,而不是空字符串。
 * - `formatRunJson` 故意省略 `result.messages`:Anthropic 原生 messages 在
 *   oneshot ask 路径下太大,脚本消费者用 finalText + trace 已足够。
 * - 工具名扁平去重顺序:`Set` 行为在 ES2015+ 规范保证按插入顺序枚举,所以
 *   用 `Array.from(new Set(...))` 同时拿到去重 + 保首次出现顺序。
 */
import type { LoopTrace, RunResult } from "../harness/index.js";

/** Tool-name list separator in status line (CLI script consumers parse this). */
const TOOL_LIST_SEP = ",";
/** Tool-list placeholder when no tool has been called. */
const NO_TOOLS = "-";

/**
 * Human projection of `RunResult` + `LoopTrace`.
 *
 * Layout:
 *   `<finalText>
 *
 *   stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> · <totalDurationMs>ms`
 *
 * `finalText === null` 时,文本部分为空字符串,状态行照常输出。
 * `trace.turns` 中无任何工具调用时,`tools=` 显示 `-`。
 */
export function formatRunHuman(result: RunResult, trace: LoopTrace): string {
  const text = result.finalText ?? "";
  const toolNames = flattenToolNames(trace);
  const tools = toolNames.length > 0 ? toolNames.join(TOOL_LIST_SEP) : NO_TOOLS;
  const status =
    `stop=${result.stopReason} · ` +
    `turns=${result.turnCount} · ` +
    `tools=${tools} · ` +
    `${trace.totals.totalDurationMs}ms`;
  return `${text}\n\n${status}`;
}

/**
 * Machine projection: pretty-printed JSON, deliberately omits `result.messages`.
 *
 * Deliberately excludes `result.messages` (Anthropic-native wire format) because
 * ask / chat oneshot scripts only need `finalText` + `stopReason` + `turnCount`
 * + `trace` for downstream parsing. Native messages stay available via
 * `RunResult` for in-process consumers; not for shell consumers.
 */
export function formatRunJson(result: RunResult, trace: LoopTrace): string {
  return JSON.stringify(
    {
      finalText: result.finalText,
      stopReason: result.stopReason,
      turnCount: result.turnCount,
      trace,
    },
    null,
    2
  );
}

/**
 * Flatten tool names across all turns, dedupe by first-occurrence order.
 * Returns an empty array when trace has no turns or no tool calls.
 *
 * Set iteration order in JS engines is insertion order; using `Array.from(new Set(...))`
 * preserves first-occurrence semantics without an extra index scan.
 */
function flattenToolNames(trace: LoopTrace): string[] {
  return Array.from(
    new Set(trace.turns.flatMap((t) => t.toolCalls.map((c) => c.toolName)))
  );
}
