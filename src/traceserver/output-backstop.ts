/**
 * `TRACE_OUTPUT_BACKSTOP` — the MCP transport's output floor for the read side.
 *
 * 值取自 `src/harness/tools/executor.ts:30` 的 `OUTPUT_HARD_CAP`（该 const 未
 * 导出）。**本模块禁 import `harness/`**（spec 假设 5：读侧核不依赖 harness），
 * 所以这里是「同值 + 注释指名来源 + 一条锁值断言」的既有仓库惯例（同
 * `src/harness/aci/tools/web-fetch.ts` 的 `FETCH_OUTPUT_BUDGET`）。锁值断言 =
 * `tests/traceserver/output-backstop.test.ts`：测里可以跨边界跑 executor，src 不
 * 可以跨边界 import。
 *
 * 为什么同值：低于 executor 又自己静默裁，等于两处权威各裁一刀 = ADR-0006:29
 * 明令避免的双层截断。ACI 面由 executor 兜，本常量只服务 MCP 面（那张皮后面没有
 * executor）。plan `trace-mcp-read-side-split` 第 14 条。
 */
export const TRACE_OUTPUT_BACKSTOP = 20_000;

/**
 * 与 `project-tool-results.ts` 的预览标记同一形状：同一读侧的两处截断标记长得很
 * 像，调用方一眼能认出「这是尾部被切了」。长度计入上面的预算。
 */
export const TRACE_BACKSTOP_MARKER = "...[truncated]";

/**
 * 超预算才切，且 **marker 计入预算**，返回值长度严格 ≤ `TRACE_OUTPUT_BACKSTOP`。
 *
 * 不照搬 executor 的 8 轮收敛循环（`executor.ts:91-114`）：那轮循环是为了让带
 * `{original}` / `{kept}` 数字的长 marker 的位数变化也不越帽，本面的 marker 长度
 * 固定，一次 `slice` 就已满足不变式，多出来的循环只是成本（ADR-0006:29 要的是同
 * 一条不变式，不是同一份实现）。
 */
export function applyTraceOutputBackstop(text: string): string {
  if (text.length <= TRACE_OUTPUT_BACKSTOP) return text;
  return (
    text.slice(0, TRACE_OUTPUT_BACKSTOP - TRACE_BACKSTOP_MARKER.length) +
    TRACE_BACKSTOP_MARKER
  );
}
