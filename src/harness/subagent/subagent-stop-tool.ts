/**
 * ADR-0101 / plan subagent-stop-and-continue T2 — `subagent_stop` ACI 工具。
 *
 * 父模型停工人的控制面，与操作员 Ctrl+X 对称：入参是本会话可见的 `task_id`
 * （spawn 回执 / 交差信封 / mailbox notice 上给过的那个），内部走既有
 * `manager.abortTask` —— 同一条先 settle 在飞 waitFor、再 SIGTERM + 5s
 * SIGKILL 兜底的杀进程路径（SC14 归因不变）。范围对齐 `bash_stop`：只停
 * 本会话派出的工人，跨会话 typed 拒收（所有权判定先于任何信号）。
 *
 * 幂等语义（ADR-0101 Decision 3）：已终态 / 找不到 → **结构化说明**（ok
 * tool_result 里的 `status` 判别），不抛成「任务失败幻觉」—— 停一个已经交差
 * 的工人不是错误。running / starting → abortTask 发起中止，终态由
 * `subagent_result` 查询（failed 承载归因）。
 *
 * **依赖注入形态**：工厂收 `manager`；装配层 `createDefaultAciRegistry`
 * 在 `subagentManager` opts 传入时实例化，缺席时不装配（与 spawn_subagent /
 * subagent_result 同门条件，registry.ts Gate 3 镜像过滤）。
 *
 * **append-only**：`name` 与 `ACI_TOOLSET_NAMES` 末位一一对应，不重排既有件。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "./manager.js";
import { ToolExecutionError } from "../errors.js";
import { assertSubagentOwnership, findSubagentTask } from "./subagent-tool-shared.js";

export interface SubAgentStopToolDeps {
  readonly manager: SubAgentManager;
}

export function createSubAgentStopTool(
  deps: SubAgentStopToolDeps
): AciToolDef {
  return Object.freeze({
    name: "subagent_stop",
    description:
      "Terminate a sub-agent this session spawned: pass the `task_id` from spawn_subagent's receipt or handoff. Runs the same kill path as the operator's Ctrl+X (SIGTERM to the worker, SIGKILL fallback after a grace period); the terminal state stays queryable with subagent_result (a stopped worker reports `failed` with its attribution). Use it to correct course: stop a running worker, then re-dispatch with a sharper task. Stopping a task that already reached a terminal state or an unknown id returns a structured note instead of a failure; tasks belonging to another conversation are rejected. Returns one JSON envelope with task_id and status.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "The task_id returned by spawn_subagent for a worker this session is running.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    aci: {
      category: "write", // 终止正在跑的进程是有副作用的动作（bash_stop 同款默认 ask）
      lazy: false, // 常驻 prompt：停工人是派发面的对称能力
      timeoutTier: "default", // 同步入口：abortTask 不 await 终态
      isConcurrencySafe: false, // 中止面不与其他调用重叠调度
      interruptBehavior: "block", // 同步 handler（bash_stop 同款）
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // input 已由 ajv strict 校验形状；此处保留 handler 直调兜底（同
      // spawn_subagent / bash_stop 的 compile-input 形态）。
      const obj = (input ?? {}) as Record<string, unknown>;
      const taskId = obj.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new ToolExecutionError(
          "subagent_stop: missing or invalid `task_id`"
        );
      }
      const info = findSubagentTask(deps.manager, taskId);
      if (info === undefined) {
        // 结构化说明：未知 id 不是「停失败」，是没有这个任务（ADR-0101 幂等）。
        return JSON.stringify({
          task_id: taskId,
          status: "not_found",
          note: "no such task in this manager (unknown or already expired)",
        });
      }
      assertSubagentOwnership(info, ctx, "subagent_stop");
      if (info.state === "completed" || info.state === "failed") {
        return JSON.stringify({
          task_id: taskId,
          status: "already_terminal",
          state: info.state,
        });
      }
      const dispatched = deps.manager.abortTask(taskId);
      if (!dispatched) {
        // starting/running → 终态的竞态：abortTask 对已终态任务返回 false，
        // 重查一次按幂等语义回报，不伪造「stopped」。
        const latest = findSubagentTask(deps.manager, taskId);
        if (latest === undefined) {
          // 两次查询之间任务整个出账（TTL 清出）：终态真值已不可知，
          // 回报 not_found 结构化说明，不兜底伪造 state。
          return JSON.stringify({
            task_id: taskId,
            status: "not_found",
            note: "task disappeared between lookup and abort (evicted from the manager before any signal)",
          });
        }
        return JSON.stringify({
          task_id: taskId,
          status: "already_terminal",
          state: latest.state,
        });
      }
      return JSON.stringify({ task_id: taskId, status: "stopped" });
    },
  });
}
