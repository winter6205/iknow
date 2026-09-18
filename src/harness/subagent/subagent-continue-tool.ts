/**
 * ADR-0102 / plan subagent-stop-and-continue T4 — `subagent_continue` ACI 工具。
 *
 * 父模型对**已死工人**再给一句：入参本会话 `task_id` + 下一句 `message`。
 * 闸全部在 manager.resumeTask 内判（寿命 / 账存在性 / 并发顶，锁句 4–5），
 * 本工具只做三件事：入参校验、所有权过滤（跨会话拒，与 subagent_stop 同门）、
 * typed 拒绝（SubAgentResumeError 判别 kind → 模型可见 ToolExecutionError）。
 * 不在工具侧重算寿命 —— 两处判会漂移。
 *
 * 再拉起 = 新 worker 进程 + 同对外句柄（ADR-0102 Decision 2/4）：工人 transcript
 * 的 rewind head 由 worker 侧 T3 的 present 臂消费（盘上有账 → 账作 prior、
 * 本轮新句进 seed），本工具不搬对话历史。身份与能力字段沿用原 def —— 没有
 * subagent_type / model 等入参，原 catalog 角色再 run()。
 *
 * **等待契约与 spawn 相同**（锁句 5）：省略 `wait` = 前景，当跳返回投影信封；
 * `wait:false` = 后景 {task_id} + mailbox 叫醒。前景臂复用 spawn 的归因 helpers
 * （label 参数化），墙钟 / abort / buffer 分流的语义两条臂一致。
 *
 * **依赖注入形态**与 append-only 位置契约同 subagent_stop（registry.ts 尾部注释）。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { SubAgentEnvelope } from "./envelope.js";
import type { SubAgentManager } from "./manager.js";
import {
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentResumeError,
  SubAgentWaitTimeoutError,
} from "./manager.js";
import { ToolExecutionError } from "../errors.js";
import {
  envelopeFromWaitTimeout,
  foregroundDrainExclusion,
  projectEnvelopeOrThrow,
  throwAbortAttribution,
} from "./spawn-subagent-tool.js";

export interface SubAgentContinueToolDeps {
  readonly manager: SubAgentManager;
}

const LABEL = "subagent_continue";

/** manager 全量枚举里按 task_id 反查（含归属会话，与 subagent_stop 同形态）。 */
function findTask(
  manager: SubAgentManager,
  taskId: string
): ReturnType<SubAgentManager["listSubagents"]>[number] | undefined {
  return manager.listSubagents().find((info) => info.taskId === taskId);
}

/**
 * SubAgentResumeError 的 kind → 模型可见文案。渲染形态 `${kind} — ${出路}`：
 * kind 词面上可见（typed-error catch 契约），三条都给出路 —— running 指回
 * stop-then-continue 的纠偏路径（中途注入不授权）；no_transcript 说明旧工人
 * 没有账、改走新 spawn；not_found 是调用面错误。放模块级：handler 圈复杂度
 * 棘轮（spawn 工具 foregroundDrainExclusion 同款先例）。
 */
function resumeRefusalMessage(err: SubAgentResumeError): string {
  switch (err.kind) {
    case "running":
      return `${LABEL}: ${err.kind} — task ${err.taskId} is still running; to correct its course, use subagent_stop first, then continue once it reaches a terminal state`;
    case "no_transcript":
      return `${LABEL}: ${err.kind} — task ${err.taskId} has no worker transcript on disk, so its dialogue cannot be replayed; dispatch a fresh spawn_subagent with the full context instead`;
    case "not_found":
      return `${LABEL}: ${err.kind} — no task ${err.taskId} is known to this session's sub-agent manager`;
  }
}

/**
 * 所有权闸（与 subagent_stop 同一道）：跨会话拒，且判定先于再拉起。
 * 未知 id 不在这里挡 —— 让它流到 manager.resumeTask 拿 not_found，
 * 寿命/账/额度的真值只在 manager 一处判（工具侧重算会漂移）。
 */
function assertOwnership(
  manager: SubAgentManager,
  taskId: string,
  ctx: ToolExecutionContext | undefined
): void {
  const info = findTask(manager, taskId);
  if (info !== undefined && info.conversationId !== ctx?.conversationId) {
    throw new ToolExecutionError(
      `${LABEL}: out_of_scope — task belongs to another conversation`
    );
  }
}

/**
 * 再拉起臂：manager 闸（寿命 / 账 / 并发顶）+ typed 拒绝映射。
 * 放模块级：handler 圈复杂度棘轮（spawn 工具 foregroundDrainExclusion 先例）。
 */
function resumeDeadWorker(
  manager: SubAgentManager,
  taskId: string,
  next: SubAgentDefinition
): { readonly taskId: string } {
  const resume = manager.resumeTask;
  if (resume === undefined) {
    // 装配漏接（poll-only fake manager）：显式失败，不静默退化成 spawn。
    throw new ToolExecutionError(
      `${LABEL}: this session's sub-agent manager does not support resume`
    );
  }
  try {
    return resume(taskId, next);
  } catch (err) {
    if (err instanceof SubAgentResumeError) {
      throw new ToolExecutionError(resumeRefusalMessage(err));
    }
    // 并发顶与 spawn 同源（锁句 5）：capacity 归因透传给模型，促其降并发。
    if (err instanceof SubAgentCapacityError) {
      throw new ToolExecutionError(err.message);
    }
    throw err;
  }
}

/**
 * 前景臂 —— spawn 前景臂同款：waitFor 缺省走 manager 三层链（def.timeoutMs
 * 是原工人的寿命，不在此重释）；abort / 墙钟 / buffer 分流复用 spawn 的
 * 归因 helpers（label 参数化），两条臂的终态语义一致。
 */
async function awaitForegroundHandoff(
  manager: SubAgentManager,
  taskId: string,
  ctx: ToolExecutionContext | undefined
): Promise<SubAgentEnvelope> {
  try {
    const envelope = await manager.waitFor(taskId, undefined, ctx?.signal);
    return projectEnvelopeOrThrow(envelope, taskId, LABEL);
  } catch (err) {
    if (err instanceof SubAgentAbortError) {
      throwAbortAttribution(err, ctx, LABEL);
    }
    if (ctx?.signal?.aborted) {
      throw new ToolExecutionError(`${LABEL}: cancelled by caller abort`);
    }
    if (err instanceof SubAgentWaitTimeoutError) {
      return envelopeFromWaitTimeout(manager.queryBuffer(taskId), taskId, LABEL);
    }
    throw err;
  }
}

/**
 * 入参校验 + `wait` 默认值解析（缺省 = 前景，锁句 5「wait 与 spawn 相同」）。
 * input 已由 ajv strict 校验形状；此处保留 handler 直调兜底（同
 * spawn_subagent / subagent_stop 的 compile-input 形态）。
 */
function readContinueInputs(obj: Record<string, unknown>): {
  readonly taskId: string;
  readonly message: string;
  readonly wait: boolean;
} {
  const taskId = obj.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new ToolExecutionError(`${LABEL}: missing or invalid \`task_id\``);
  }
  const message = obj.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new ToolExecutionError(`${LABEL}: missing or invalid \`message\``);
  }
  return { taskId, message, wait: obj.wait !== false };
}

/**
 * 本跳 def：只带回合与交付通道字段；身份/能力字段由 manager 从原 def 沿用
 * （见 resumeDefinition）。不带 conversationId —— 归属是身份的一部分。
 */
function continueTurnFields(
  message: string,
  ctx: ToolExecutionContext | undefined,
  wait: boolean
): SubAgentDefinition {
  return {
    task: message,
    ...(ctx?.turnId !== undefined ? { parentTurnId: ctx.turnId } : {}),
    ...(ctx?.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
    ...foregroundDrainExclusion(wait),
  };
}

export function createSubAgentContinueTool(
  deps: SubAgentContinueToolDeps
): AciToolDef {
  return Object.freeze({
    name: "subagent_continue",
    description:
      "Hand one more message to a sub-agent whose process is dead and continue its dialogue: pass the `task_id` from spawn_subagent plus the next `message`. The gate is process lifetime — a worker that reached any terminal state (completed, failed, or stopped) resumes with a fresh process that loads its worker transcript as prior context and runs the original subagent type and capabilities; the external handle stays the same task_id. While a worker is still running, use subagent_stop first — corrections arrive between turns, by stop then continue. A worker without a transcript on disk (dispatched before transcript accounting existed) gets a structured refusal — send it a fresh spawn_subagent instead. Default `wait:true` — the call blocks until the resumed run finishes and returns the parent-visible short handoff (summary, changed paths, status, stop_reason when available). Pass `wait:false` for fire-and-forget: returns {task_id} immediately and terminal completion wakes the host through the mailbox. Unknown task_id and tasks belonging to another conversation are refused with a structured error. Continuations share the same concurrency cap as spawn_subagent.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "The task_id returned by spawn_subagent for a dead worker of this session (completed, failed, or stopped).",
        },
        message: {
          type: "string",
          description:
            "The next sentence for the worker — appended to its transcript history as a user turn, then the fresh process runs with it as the task.",
        },
        wait: {
          type: "boolean",
          description:
            "When true (default), block until the resumed run finishes and return the parent-visible short handoff. When false, return {task_id} immediately; terminal completion wakes a silent run through the host mailbox/subscription.",
        },
      },
      required: ["task_id", "message"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 与 spawn_subagent 同归类（执行耗时但不改文件系统 —— ACR verdict 1 同门）
      lazy: false, // 常驻 prompt：续跑是派发面的对称能力（stop 同款理由）
      timeoutTier: "unbounded", // 前景臂寿命 = manager per-task 钟，ACI 不 timer（spawn 同款）
      isConcurrencySafe: true, // 不同 task_id 的续跑可同轮并行（spawn 同契约）
      interruptBehavior: "cancel", // 前景入口；ctx.signal abort → waitFor reject → 归因 cancelled
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const obj = (input ?? {}) as Record<string, unknown>;
      const { taskId, message, wait } = readContinueInputs(obj);
      assertOwnership(deps.manager, taskId, ctx);
      const next = continueTurnFields(message, ctx, wait);
      const resumed = resumeDeadWorker(deps.manager, taskId, next);
      // 后景臂与 spawn 的 wait:false 同形态：即返 {task_id}，终态走 mailbox。
      if (!wait) {
        return JSON.stringify({ task_id: resumed.taskId });
      }
      return awaitForegroundHandoff(deps.manager, resumed.taskId, ctx);
    },
  });
}
