/**
 * PROTOTYPE — Self-written Graph 多任务编排：NodeExecutor ↔ SubAgentManager 适配。
 *
 * 设计：本模块把 Graph 节点的执行收敛为「一次 foreground spawn + waitFor」
 * （ADR-0014 V1.5 前台默认值）：每节点 = 一次 SubAgentManager.spawn(def)
 * + manager.waitFor(taskId)，等待子代理终态后把 envelope.result 作为 NodeOutcome。
 *
 * 关键决策：
 * - 不引入第二份并发上限。SubAgentManager.MAX_CONCURRENT_WORKERS = 4 是项目
 *   唯一权威并发容量，溢出 typed 拒绝 (SubAgentCapacityError)；scheduler 通过
 *   try/catch 转成 NodeOutcome { status:"failed", error }，让 findFailedUpstream
 *   把分支后续节点标 skipped（fail-fast 沿 deps 链向上传播）。
 * - 复用 SubAgentManager 内置的 TraceService seam；manager 在 spawn/stop/
 *   state_change 三处已经埋点 (subagent_spawn / subagent_state_change /
 *   subagent_stop)，graph 层不重复定义 recordGraphNodeStart/End，避免新事件
 *   类型爆炸（test 规约 jsonl.ts:268-326）。
 * - 不创建第二份 SessionStore 持久化权威：节点结果通过 spawn_subagent
 *   工具的 tool_result 路径写回 append-only messages（manager 装配契约）。
 *
 * 边界：仅依赖 subagent/（manager / envelope）与 trace/types；不 import
 * loop-engine / build-engine / index.ts。
 */

import { randomUUID } from "node:crypto";

import {
  SubAgentCapacityError,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../subagent/manager.js";
import type { SubAgentEnvelope } from "../subagent/envelope.js";
import { safeTrace } from "../trace/safe-trace.js";
import type {
  SubagentStepRecord,
  TraceErrorType,
  TraceService,
} from "../trace/types.js";
import type { NodeContext, NodeExecutor, NodeOutcome } from "./types.js";

/** 单节点到 SubAgentDefinition 的映射。 */
export interface NodePlan {
  /** 传给子代理的 task 文本（worker envelope.task 必填）。 */
  readonly task: string;
  /** 可选 systemPrompt / disallowedTools / model / maxTurns / timeoutMs / role。 */
  readonly def?: Omit<SubAgentDefinition, "task">;
}

/** NodeExecutor 工厂依赖：manager + per-node plan。 */
export interface SubAgentNodeExecutorOptions {
  readonly manager: SubAgentManager;
  readonly plans: Readonly<Record<string, NodePlan>>;
  /**
   * D-α T4:调用侧取消信号（ACI `ctx.signal`）。透传给 `manager.waitFor`，
   * 让父回合被打断时前景等待立刻 reject 而不是空等到 per-task 墙钟。
   * 缺席 → 与 V1 逐字节一致（waitFor 不带 signal）。
   */
  readonly signal?: AbortSignal;
  /** 可选 SUBAGENT_STEP 写侧（graph 编排 dispatch/settle）。 */
  readonly trace?: TraceService;
  /**
   * 派出这张图的那一回合的 trace turn id（F-4）。给了就同时进节点 def
   * （→ manager 三类 record）与本执行器发的 `subagent_step`。
   */
  readonly parentTurnId?: string;
}

/** envelope.reason → TraceErrorType（无对应成员时归 unknown）。 */
function stepErrorType(reason: SubAgentEnvelope["reason"]): TraceErrorType {
  return reason === "timeout" || reason === "protocolError"
    ? reason
    : "unknown";
}

/**
 * 把 {id -> NodePlan} + manager 装成 NodeExecutor。
 *
 * 节点执行 = manager.spawn(def) + manager.waitFor(taskId)：
 *   - spawn 抛 SubAgentCapacityError → 立即上抛，scheduler 的 try/catch
 *     把本节点定为 failed，后续依赖者因 findFailedUpstream 被 skipped
 *     （沿 deps 链 fail-fast），独立分支不受影响。
 *   - waitFor 返回 envelope：status === "ok" → { done, output = envelope.result }；
 *     status === "failed" → { failed, error = envelope.summary || reason }。
 *   - waitFor 抛错（超时 / abort / shutdown）→ 上抛，scheduler 同样归 failed。
 *
 * 注：plan 必须覆盖 spec 中所有节点 id；缺 plan → 节点 failed (error 含
 * "no plan registered for id")。这是开发期配置错漏的快速反馈面。
 */
export function createSubAgentNodeExecutor(
  opts: SubAgentNodeExecutorOptions
): NodeExecutor {
  const { manager, plans, signal, trace, parentTurnId } = opts;
  let nextStepIndex = 0;
  const parentTurnFields =
    parentTurnId !== undefined ? { parentTurnId } : ({} as const);

  function emitStep(fields: Omit<SubagentStepRecord, "id" | "origin">): void {
    if (!trace) return;
    void safeTrace(() =>
      trace.recordSubagentStep({
        id: randomUUID(),
        origin: "parent",
        ...parentTurnFields,
        ...fields,
      })
    );
  }

  return async (id: string, _ctx?: NodeContext): Promise<NodeOutcome> => {
    const plan = plans[id];
    if (!plan) {
      return {
        status: "failed",
        error: `no graph-node plan registered for id "${id}"`,
      };
    }
    const def: SubAgentDefinition = {
      ...(plan.def ?? {}),
      excludeFromHostDrain: true,
      ...(parentTurnId !== undefined ? { parentTurnId } : {}),
      task: plan.task,
    };
    const { taskId } = manager.spawn(def);
    const stepIndex = nextStepIndex++;
    const startedAt = new Date().toISOString();
    emitStep({
      taskId,
      stepIndex,
      phase: "dispatch",
      label: id,
      startedAt,
      status: "ok",
      ts: startedAt,
    });
    let envelope: SubAgentEnvelope;
    try {
      envelope = await manager.waitFor(taskId, undefined, signal);
    } catch (err) {
      if (err instanceof SubAgentCapacityError) {
        return {
          status: "failed",
          error: `${err.name}: ${err.message} (active=${err.active})`,
        };
      }
      throw err;
    }
    const endedAt = new Date().toISOString();
    if (envelope.status === "ok") {
      emitStep({
        taskId,
        stepIndex,
        phase: "settle",
        label: id,
        startedAt,
        endedAt,
        status: "ok",
        ts: endedAt,
      });
      return { status: "done", output: envelope.result };
    }
    const reasonText = envelope.reason ? `[${envelope.reason}] ` : "";
    const summary =
      envelope.summary ?? "subagent returned failed without summary";
    emitStep({
      taskId,
      stepIndex,
      phase: "settle",
      label: id,
      startedAt,
      endedAt,
      status: "error",
      error: {
        type: stepErrorType(envelope.reason),
        message: `${reasonText}${summary}`.trim(),
      },
      ts: endedAt,
    });
    return {
      status: "failed",
      error: `${reasonText}${summary}`.trim(),
    };
  };
}
