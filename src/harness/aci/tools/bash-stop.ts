/**
 * #502 T4 — bash_stop ACI 工具（Track A 模型操作面）。
 *
 * 用途：终止由 `bash` 工具以 `background: true` 启动的后台任务。manager.stop
 * 实现 host 侧 kill(-pgid)：SIGTERM → 2s 宽限 → SIGKILL（manager.ts:477-527）；
 * 对已终态任务幂等成功（合法态，不抛错、不二次发信号，kill_race 语义 T2 定稿）。
 *
 * Permission（#502 票明示）：category "write" → 默认 ask。后台任务终止是
 * 有副作用的动作（杀掉正在跑的长驻服务 / 构建），模型调用需用户确认，
 * 与 todo_write 的 write→ask 同形态。
 *
 * 描述（D9 决议）：仅正面引导条件（何时用 / 与什么工具配对），不写负面禁令词。
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import { renderTaskError } from "../../background/registry.js";
import type { BackgroundTaskError } from "../../background/registry.js";

export interface CreateBashStopToolOptions {
  readonly backgroundManager: BackgroundTaskManager;
}

interface BashStopInput {
  readonly task_id?: unknown;
}

/**
 * 工厂：createBashStopTool(deps) — bash_stop 工具（第 30 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "bash_stop"
 *   - inputSchema: { task_id 必填 }，additionalProperties:false
 *   - aci 元数据：write / NOT concurrency-safe / block / default tier
 *   - handler 输出 JSON `{task_id, status:"stopped"}`；task_id 空串透传给
 *     manager → empty_task_id typed-error（不拦截）。manager.stop 对未知
 *     task_id 抛 task_not_found → 渲染 `${kind}: ${context}`。
 */
export function createBashStopTool(
  opts: CreateBashStopToolOptions
): AciToolDef {
  const handler = async (
    input: unknown,
    _ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileStopInput(input);
    try {
      await opts.backgroundManager.stop(parsed.task_id);
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      // typed-error catch 契约：kind 判别后用 renderTaskError 渲染 `${kind}:
      // ${context}`，禁 [object Object]。manager 抛 plain object（判别联合
      // BackgroundTaskError），不是 Error instance，按契约走 renderTaskError。
      throw new ToolExecutionError(
        `bash_stop: ${renderTaskError(err as BackgroundTaskError)}`
      );
    }
    return JSON.stringify({ task_id: parsed.task_id, status: "stopped" });
  };

  return Object.freeze({
    name: "bash_stop",
    description:
      'Terminate a background bash task previously spawned with bash(background: true). Use when a background task is no longer needed (a server has served its purpose, a build finished, or the task is stuck) and its process group should be sent SIGTERM, escalated to SIGKILL after a 2-second grace period. Accepts the task_id returned by bash(background: true); stopping an already-finished task succeeds silently. Returns one JSON envelope with task_id and status="stopped".',
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Background task id returned by bash(background: true); the process group is terminated and the busy state at the task registry is released.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * 输入编译 + 严格校验：task_id 必填且为字符串（允许空串 → manager 走
 * empty_task_id typed-error 透传；非对象 / 缺 task_id / 类型错 →
 * ToolExecutionError 自身防御，schema 之外的兜底）。
 */
function compileStopInput(input: unknown): {
  readonly task_id: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[bash_stop] input must be an object");
  }
  const raw = input as BashStopInput;
  if (typeof raw.task_id !== "string") {
    throw new ToolExecutionError(
      "[bash_stop] task_id is required and must be a string"
    );
  }
  return { task_id: raw.task_id };
}
