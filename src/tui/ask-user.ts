/**
 * src/tui/ask-user.ts
 *
 * #146 TUI 专用 AskUser 桥接：ink 全屏 raw mode 下 readline 不可用，
 * 仿 createServeAskUser 的 queue-based + fail-closed 纪律（#115 H3），
 * 但 resolve 入口在 TUI 状态机（用户在输入框键入 y/n 或按对应键）。
 *
 * 语义：
 *  - ask(ctx) 分配 `ask-N`，挂 fail-closed 定时器（默认 60s，unref）；
 *  - 仅 resolveAsk(id, true) 可放行；超时 / 未知 id → false；
 *  - pending() 供 UI 渲染提示行（工具名 + summaryHint + id）。
 */
import type { AskUser } from "../harness/permission/types.js";

export interface TuiPendingAsk {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
}

export interface TuiAskUserBridge {
  readonly ask: AskUser;
  readonly resolveAsk: (id: string, approved: boolean) => boolean;
  readonly pending: () => TuiPendingAsk | undefined;
  readonly pendingCount: () => number;
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
      readonly timer: NodeJS.Timeout;
    }
  >();
  let counter = 0;

  function settle(id: string, approved: boolean): boolean {
    const entry = queue.get(id);
    if (!entry) return false;
    queue.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }

  const ask: AskUser = (ctx) => {
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean>((resolve) => {
      // 先挂 fail-closed 定时器，同 tick resolveAsk 也能赢（settle 清 timer）。
      const timer = setTimeout(() => {
        settle(id, false);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      queue.set(id, {
        info: { id, tool: ctx.tool, summaryHint: ctx.summaryHint },
        resolve,
        timer,
      });
    });
  };

  return Object.freeze({
    ask: Object.freeze(ask),
    resolveAsk: (id: string, approved: boolean): boolean =>
      settle(id, approved),
    pending: (): TuiPendingAsk | undefined => queue.values().next().value?.info,
    pendingCount: () => queue.size,
  });
}
