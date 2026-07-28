/**
 * Signal-aware stub tool (S17 守门 vehicle)。
 *
 * 示例 stub:响应 ctx.signal —— abort 立即或等待期间打断,handler
 * reject DOMException("AbortError")。Executor 捕获后会把它收敛为
 * 统一的 execution_failed 标签。不进生产装配路径,仅供测试断言
 * "abort → 失败标签" 这条端到端链路。
 */

import type { ToolDef } from "../tools/types.js";

export interface StubSignalToolOptions {
  readonly name?: string;
  /** 等待时长(ms);用于"等待期间 abort"的测试用例。默认 0(立刻 resolve)。 */
  readonly delayMs?: number;
}

export function createStubSignalTool(
  opts: StubSignalToolOptions = {}
): ToolDef {
  const name = opts.name ?? "stub_signal";
  const delayMs = opts.delayMs ?? 0;
  return Object.freeze<ToolDef>({
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    handler: (async (input: unknown, ctx?: { signal?: AbortSignal }) => {
      const signal = ctx?.signal;
      // 入口已 abort:立刻拒绝,不允许执行业务逻辑。
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
            return;
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return input;
    }) as ToolDef["handler"],
  });
}
