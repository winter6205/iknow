/**
 * src/tui/ask-user.ts
 *
 * #343 T4（自 archive/tui-ink/src/ask-user.ts 迁移，语义不变）：
 * TUI 专用 AskUser 桥接 —— 全屏 raw mode 下 readline 不可用，仿
 * createServeAskUser 的 queue-based + fail-closed 纪律（#115 H3），
 * resolve 入口在 TUI 状态机（用户在权限 modal 键入 y/n/a 或 ↑↓Enter）。
 *
 * 语义：
 *  - ask(ctx) 分配 `ask-N`，挂 fail-closed 定时器（默认 60s，unref）；
 *  - 仅 resolveAsk(id, true) 可放行；超时 / caller abort / 未知 id → false；
 *  - pending() 供 UI 渲染提示（工具名 + summaryHint + id）。
 */
import type { AskUser } from "../harness/permission/types.js";

export interface TuiPendingAsk {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
  /** #503 T10 / ADR-0022:bash network:true 时由 executor 透传；缺省时该
   *  key 不存在。TUI 权限 modal 可据此渲染宿主网络标记行。 */
  readonly network?: boolean;
}

export interface TuiAskUserBridge {
  readonly ask: AskUser;
  readonly resolveAsk: (id: string, approved: boolean) => boolean;
  readonly pending: () => TuiPendingAsk | undefined;
  readonly pendingCount: () => number;
  /** pending 变化通知（enqueue / settle 各触发一次）。TUI 据此即时
   *  re-render 挂/摘 modal。返回退订函数。 */
  readonly subscribe: (cb: () => void) => () => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createTuiAskUserBridge(opts?: {
  readonly timeoutMs?: number;
}): TuiAskUserBridge {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const queue = new Map<
    string,
    {
      readonly info: TuiPendingAsk;
      readonly resolve: (v: boolean) => void;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly signal: AbortSignal | undefined;
      readonly onAbort: () => void;
    }
  >();
  let counter = 0;
  const subs = new Set<() => void>();
  const notify = (): void => {
    for (const cb of subs) cb();
  };

  function settle(id: string, approved: boolean): boolean {
    const entry = queue.get(id);
    if (!entry) return false;
    queue.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(approved);
    notify();
    return true;
  }

  const ask: AskUser = (ctx) => {
    if (ctx.signal?.aborted === true) return Promise.resolve(false);
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean>((resolve) => {
      // 先挂 fail-closed 定时器，同 tick resolveAsk 也能赢（settle 清 timer）。
      const timer = setTimeout(() => {
        settle(id, false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const onAbort = (): void => {
        settle(id, false);
      };
      queue.set(id, {
        info: {
          id,
          tool: ctx.tool,
          summaryHint: ctx.summaryHint,
          ...(ctx.network !== undefined ? { network: ctx.network } : {}),
        },
        resolve,
        timer,
        signal: ctx.signal,
        onAbort,
      });
      if (ctx.signal !== undefined) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) settle(id, false);
      }
      if (queue.has(id)) notify();
    });
  };

  return Object.freeze({
    ask: Object.freeze(ask),
    resolveAsk: (id: string, approved: boolean): boolean =>
      settle(id, approved),
    pending: (): TuiPendingAsk | undefined => queue.values().next().value?.info,
    pendingCount: () => queue.size,
    subscribe: (cb: () => void): (() => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  });
}
