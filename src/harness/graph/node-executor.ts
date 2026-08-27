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

import {
  SubAgentCapacityError,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../subagent/manager.js";
import type { SubAgentEnvelope } from "../subagent/envelope.js";
import type { NodeExecutor, NodeOutcome } from "./types.js";

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
  const { manager, plans, signal } = opts;
  return async (id: string): Promise<NodeOutcome> => {
    const plan = plans[id];
    if (!plan) {
      return {
        status: "failed",
        error: `no graph-node plan registered for id "${id}"`,
      };
    }
    const def: SubAgentDefinition = {
      ...(plan.def ?? {}),
      task: plan.task,
    };
    // spawn 同步入口（manager 内部 randomUUID）—— 立即返回 taskId 或抛
    // SubAgentCapacityError（≥ MAX_CONCURRENT_WORKERS in-flight 时）。
    const { taskId } = manager.spawn(def);
    let envelope: SubAgentEnvelope;
    try {
      // 前景阻塞至子代理终态（ADR-0014 V1.5 默认 wait:true 等价）。
      // 缺省 timeoutMs 走 manager 三层链 (def.timeoutMs ?? opts.taskTimeoutMs ??
      // PER_TASK_TIMEOUT_MS) — 单点声明保证 spawn 计时与 wait 超时同源。
      envelope = await manager.waitFor(taskId, undefined, signal);
    } catch (err) {
      // waitFor 抛错 → typed 拒绝 surface 上抛，scheduler 转 failed。
      if (err instanceof SubAgentCapacityError) {
        // 容量拒绝（spawn 内已抛；防御兜底，正常路径不会命中）。
        return {
          status: "failed",
          error: `${err.name}: ${err.message} (active=${err.active})`,
        };
      }
      throw err;
    }
    if (envelope.status === "ok") {
      return { status: "done", output: envelope.result };
    }
    // status === "failed" 必有 summary / reason 之一。
    const reasonText = envelope.reason ? `[${envelope.reason}] ` : "";
    const summary =
      envelope.summary ?? "subagent returned failed without summary";
    return {
      status: "failed",
      error: `${reasonText}${summary}`.trim(),
    };
  };
}
