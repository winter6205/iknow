/**
 * Shared ownership-check seam for subagent_stop and subagent_continue.
 *
 // (ADR-0101 ADR-0102)
 *
 * Why it exists: task_id lookup + "belongs to this conversation" filtering is
 * byte-identical logic in both tools, and ownership is a security gate (reject
 * cross-conversation before any signal or re-spawn). Keeping two copies would
 * drift when only one gets updated. Single check, parameterized label, so the
 * model-visible wording stays byte-identical to the pre-extraction version.
 */
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubagentInfo, SubAgentManager } from "./manager.js";
import { ToolExecutionError } from "../errors.js";

/** Reverse-lookup by task_id in the manager's full listing (Postel: absent entry means no owner). */
export function findSubagentTask(
  manager: SubAgentManager,
  taskId: string
): SubagentInfo | undefined {
  return manager.listSubagents().find((info) => info.taskId === taskId);
}

/**
 * Ownership gate: known owner that is not this conversation → ToolExecutionError.
 * Unknown ids are not blocked here — the exit belongs to the caller (stop:
 * structured not_found explanation; continue: defer to manager.resumeTask for
 * real lifetime/budget/quota truth, since checking in two places would drift).
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
