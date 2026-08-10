/**
 * #356 T7 — host drain: 在 chat / tui / serve 三入口的 run() 边界之间,把
 * SubAgentManager buffer 内 completed 任务浓缩成 user message 字符串,拼入
 * 下一次 run() 的 priorMessages。
 *
 * 关键纪律 (spec SC7 / OQ5):
 *   - 空 manager (undefined) → 返回 "";
 *   - manager 无 completed → 返回 "";
 *   - 混合 completed + running → 只 drain completed (drainCompleted API 已
 *     只列 completed,running 不出现);
 *   - 不修改 manager buffer 状态 (OQ5 buffer 永久缓存直到 shutdown);
 *   - 单 task 浓缩格式:
 *       ## Sub-agent <taskId> result: <summary>
 *
 *       [result]
 *     多 task 用空行分隔。
 *
 * ask 入口无 manager → 不调本函数 → 不行为变化。
 */
import type { SubAgentManager } from "./manager.js";

/**
 * 浓缩 completed 子代理结果为一条 user message 字符串。
 *
 * 返回 "" 当:
 *   - manager 为 undefined (ask 入口形态);
 *   - manager 内无 completed 任务 (空 buffer 或全部 running/failed)。
 *
 * 返回的字符串可直接作为一条 user message 的 text 内容,拼入
 * run({priorMessages}) 的 priorMessages 末尾。
 */
export function drainPendingSubagents(
  manager: SubAgentManager | undefined
): string {
  if (manager === undefined) return "";
  const list = manager.drainCompleted();
  if (list.length === 0) return "";
  return list
    .map(
      ({ taskId, envelope }) =>
        `## Sub-agent ${taskId} result: ${envelope.summary}\n\n${envelope.result}`
    )
    .join("\n\n");
}
