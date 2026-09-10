/**
 * 节点执行异常 → `error` 字符串的渲染契约（per code-quality.md typed-error
 * catch）：优先识别判别联合 `{kind, context}`；未知形态退回到 `err.message`；
 * 最末对非数组对象用 safe JSON 渲染（不可序列化时给构造器名描述），其余走
 * `String(err)`。
 *
 * 禁止 `err instanceof Error ? err.message : String(err)`（plain typed object
 * 会被打成 `[object Object]`，让 kind/context 完全不可见）。
 *
 * 边界：纯函数，不 import 调度器 / 账本 / node-executor；既被阶段 1 的
 * `scheduler.ts` 也被阶段 2 的 `outcome-scheduler.ts` 调用，避免重复实现
 * 漂移（review F5）。
 */

/**
 * 非 kind plain object 的最后兜底：JSON 序列化，失败（循环引用 /
 * BigInt 等不可序列化值）时退回到构造器名描述 —— 保证永不输出
 * `[object Object]`，也永不抛异常。
 */
function safeObjectString(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    const ctorName = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    return `unrenderable object: ${
      typeof ctorName === "string" && ctorName ? ctorName : "unknown"
    } (circular or non-serializable)`;
  }
}

export function formatNodeError(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind?: unknown; context?: unknown };
    const kind = typeof e.kind === "string" ? e.kind : "unknown";
    const ctxStr =
      e.context !== undefined ? JSON.stringify(e.context) : JSON.stringify(err);
    return `${kind}: ${ctxStr}`;
  }
  if (err instanceof Error) return err.message;
  // 非数组的对象（无 kind）走 safe JSON；数组与 primitive 沿用 String()
  // （array 已有可读形式 "1,2,3"，primitive 的 String 形式即可读）。
  if (typeof err === "object" && err !== null && !Array.isArray(err)) {
    return safeObjectString(err);
  }
  return String(err);
}
