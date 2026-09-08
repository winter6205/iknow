/**
 * 节点执行异常 → `error` 字符串的渲染契约（per code-quality.md typed-error
 * catch）：优先识别判别联合 `{kind, context}`；未知形态退回到 `err.message`；
 * 最末回到 `String(err)`。
 *
 * 禁止 `err instanceof Error ? err.message : String(err)`（plain typed object
 * 会被打成 `[object Object]`，让 kind/context 完全不可见）。
 *
 * 边界：纯函数，不 import 调度器 / 账本 / node-executor；既被阶段 1 的
 * `scheduler.ts` 也被阶段 2 的 `outcome-scheduler.ts` 调用，避免重复实现
 * 漂移（review F5）。
 */
export function formatNodeError(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind?: unknown; context?: unknown };
    const kind = typeof e.kind === "string" ? e.kind : "unknown";
    const ctxStr =
      e.context !== undefined ? JSON.stringify(e.context) : JSON.stringify(err);
    return `${kind}: ${ctxStr}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
