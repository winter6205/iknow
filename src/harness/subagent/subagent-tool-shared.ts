/**
 * ADR-0101 / ADR-0102 — subagent_stop 与 subagent_continue 的共享判定缝。
 *
 * 存在理由：task_id 反查 + 「归属本会话」所有权过滤是两工具逐字相同的判定，
 * 而所有权是安全闸（信号 / 再拉起之前必须先拒跨会话）—— 两处各留一份，
 * 将来只改一处就会漂移。单处判定、label 参数化，保证模型可见文案与
 * 提取前逐字节一致（行为不变）。
 */
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubagentInfo, SubAgentManager } from "./manager.js";
import { ToolExecutionError } from "../errors.js";

/** manager 全量枚举里按 task_id 反查（含归属会话，Postel 缺席即无归属）。 */
export function findSubagentTask(
  manager: SubAgentManager,
  taskId: string
): SubagentInfo | undefined {
  return manager.listSubagents().find((info) => info.taskId === taskId);
}

/**
 * 所有权闸：已知归属且不是本会话 → ToolExecutionError。未知 id 不在此挡
 * —— 出路归调用方（stop：not_found 结构化说明；continue：放到
 * manager.resumeTask 拿寿命/账/额度的真值，两处判会漂移）。
 */
export function assertSubagentOwnership(
  info: SubagentInfo,
  ctx: ToolExecutionContext | undefined,
  label: string
): void {
  if (info.conversationId !== ctx?.conversationId) {
    throw new ToolExecutionError(
      `${label}: out_of_scope — task belongs to another conversation`
    );
  }
}
