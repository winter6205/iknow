/**
 * src/tui/quit-abort.ts
 *
 * SC12（`specs/agent-control-surface.md` Slice D）/ plan task 7：`/quit` 先 abort
 * 当前前台 turn，再等收尾 —— 不等子代理 per-task 墙钟（缺省 7200s）。
 *
 * 为什么单独成模块而不是内联进 app.tsx：app.tsx 已 3300+ 行且在 S5 复杂度
 * 压力下（同 chat-view.tsx god function 的拆分纪律），此处只留一个调用点。
 * 本助手是纯函数，单测不渲染整个 TUI。
 *
 * 语义边界（#146 Q1a 状态机 + R2 票面）：
 *  - 只 abort **当前活跃会话** 的前台 turn（`running-fg`）——规格原文
 *    「先 abort 当前前台 turn」。
 *  - 后台会话（`running-bg`）**不动**：/quit 的二次确认分支仍会等它们落盘，
 *    本助手不改变那条既有语义。
 *  - 无 controller（turn 收尾竞态已摘表）/ draft 会话（conversationId 为
 *    undefined）→ no-op，不抛错、不伪造 controller。
 *
 * abort 出口链路（R2 已核实，本助手只复用、不另开一条）：
 *   controller.abort() → bridge.postMessage({signal}) → hub.postMessage →
 *   run(…, opts.signal) → executor（interruptBehavior="cancel" 透传）→
 *   spawn_subagent handler 的 ctx.signal → manager.waitFor(taskId, …,
 *   ctx.signal) → SubAgentAbortError。
 */
import { canInterrupt, type TuiSessionState } from "./session-state.js";

/** `aborters.current`（Map<string, AbortController>）的最小只读面。 */
export interface AbortControllerLookup {
  readonly get: (conversationId: string) => AbortController | undefined;
}

export interface QuitAbortInput {
  readonly session: TuiSessionState;
  readonly aborters: AbortControllerLookup;
}

/**
 * /quit 收尾前的第一步：abort 当前会话的前台 turn。
 * 返回是否真的发出了 abort —— 调用方不需要该值（幂等收尾），
 * 它存在只是让测试能观测「有没有 abort」而不必读内部状态。
 */
export function abortForegroundTurnOnQuit(input: QuitAbortInput): boolean {
  const { session, aborters } = input;
  // canInterrupt 是 `running-fg` 的单一判据（Esc / /quit 同源消费）——
  // 不在此复写 `runState === "running-fg"` 字面量。
  if (!canInterrupt(session)) return false;
  const id = session.conversationId;
  if (id === undefined) return false;
  const controller = aborters.get(id);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}
