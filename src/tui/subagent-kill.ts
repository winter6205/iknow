/**
 * src/tui/subagent-kill.ts
 *
 * spec Slice D / SC14–SC15（`specs/agent-control-surface.md`）/ plan task 8：
 * chrome-focus 聚焦子代理行时 **Ctrl+X** 强杀该子代理；无聚焦 → 空操作。
 *
 * 为什么单独成模块：app.tsx 3300+ 行且在 S5 复杂度压力下 —— 键位处理只留
 * 一个调用点，本模块是纯函数，单测不渲染 TUI。
 *
 * 行 → taskId 的唯一映射：复用面板的 live 行序 ——
 * `projectSubagentLines` 的 live 前缀（`src/tui/subagent-panel.tsx`）只对
 * starting/running 行递增下标，且 failed/completed 只会追加在 live 之后。
 * 因此 `liveSubagents(subagents)[row]` 与面板 `focusedRow` 指的是同一行，
 * 聚焦与强杀不会各算一套。
 * 判据本身是共享的单一谓词 `isLiveSubagent`
 * （`src/tui/subagent-message-lines.ts`）—— 面板、投影、强杀三处不再各写
 * 一份 `state === "starting" || state === "running"` 字面量。
 *
 * 边界（SC15 empty + 陈旧行）：
 *   - focus 不是 subagent（input / graph）→ no-op；
 *   - row 不是非负整数（NaN / 负数 / 小数 / undefined）→ no-op；
 *   - row ≥ live 数（focus 陈旧：子代理刚终态、下一 tick 尚未 clamp）→ no-op；
 *   - 无 live 子代理 → no-op。
 *   以上全部返回 `{ kind: "none" }`，不抛错、不伪造 taskId。
 *
 * 父 turn 的 cancelled 来自哪里（SC14 的完整归因链）：
 *   `abortTask` 先以 `SubAgentAbortError` settle 该任务在飞的 `waitFor`
 *   （manager 的单任务拒绝集），再 abort worker 子进程（SIGTERM + 5s
 *   SIGKILL 兜底）。父侧前景 `waitFor(taskId, …, ctx.signal)` 因此**无需**
 *   自己的 abort 信号就收敛：handler 把 typed abort 转成 `ToolExecutionError`
 *   （操作员强杀文本），executor 因调用方 signal 未 abort 而原样透出 ——
 *   模型可见归因是「被操作员杀掉」，与墙钟超时的 `wall-clock timeout`、
 *   Ctrl+C / `/quit` 的严格 `"cancelled"` 三者互不撞脸。
 *   顺序契约：拒绝先于 SIGTERM —— 否则 worker 对 SIGTERM 的收尾会写回
 *   `reason:"timeout"` 信封，把操作员强杀误标成墙钟到期。
 *   本模块只负责「聚焦行 → 杀对 taskId」，链路本身归 manager。
 */
import type { SubagentInfo } from "../harness/subagent/manager.js";
import type { ChromeFocus } from "./chrome-focus.js";
import { isLiveSubagent } from "./subagent-message-lines.js";

/** 与 `projectSubagentLines` 的 live 前缀同源：只认 starting / running。 */
export function liveSubagents(
  subagents: ReadonlyArray<SubagentInfo>
): ReadonlyArray<SubagentInfo> {
  return subagents.filter(isLiveSubagent);
}

export type KillSubagentDispatch =
  | { readonly kind: "none" }
  | { readonly kind: "kill"; readonly taskId: string; readonly role?: string };

/**
 * Ctrl+X 的纯分派：聚焦行 → 该行 live 子代理的 taskId；否则 no-op。
 * 不调用 abort，只决定「杀谁」（调用方把 taskId 交给 bridge.abortSubagentTask）。
 */
export function dispatchKillFocusedSubagent(
  focus: ChromeFocus,
  subagents: ReadonlyArray<SubagentInfo>
): KillSubagentDispatch {
  if (focus.kind !== "subagent") return { kind: "none" };
  const row = focus.row;
  if (!Number.isInteger(row) || row < 0) return { kind: "none" };
  const target = liveSubagents(subagents)[row];
  if (target === undefined) return { kind: "none" };
  return target.role !== undefined
    ? { kind: "kill", taskId: target.taskId, role: target.role }
    : { kind: "kill", taskId: target.taskId };
}
