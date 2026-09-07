/**
 * live-graph-phase2 T3 —— effort 熔断（spec SC7 / ADR-0057 / 0064）。
 *
 * effort = 一次 `run_graph` 调用内、每个节点 id 被 executor 进入的次数
 * （含首次）。阈值 **8**，第 9 次进入同一 id → 熔断整次调用。正常失败
 * 绕回不应碰到；空转（如恒 failed 的 self-onFailure 无限串行再进入）
 * 应碰到。本数字不进 settings（ADR-0064）——要改再另开决策。
 *
 * 熔断闸在 handler 的 executor 入口，不在调度器 / 校验层
 * （complexity-anti-drift：不把 effort 塞进 validateGraph / topo /
 * on-failure）。熔断通过 `signal`（AbortController）通知调度器：in-flight
 * 节点按真实结局落定，不再启动任何新进入，整次调用随之收敛；
 * handler 按 T2 violation 同一 partial-results 通道先冻结 done 再 typed 拒。
 *
 * 计数按单次调用计：熔断只关这一次 handler —— 外环下一段剩余子图交
 * 新 id 不受影响。
 *
 * 边界：纯计数器 + abort 信号，不 import 调度器 / 账本 / node-executor。
 */

import { EFFORT_FUSE_THRESHOLD } from "./effort-threshold.js";

export interface EffortFuse {
  /**
   * executor 入口每次进入调一次。该 id 第 9 次进入（超过阈值）返回
   * false —— 调用方必须零 spawn 并让调用收敛；false 之后所有进入都拒、
   * 不再计数。计数不区分节点状态 —— 进 executor 就是进入（含首次）。
   */
  enter(id: string): boolean;
  /** 熔断即 aborted；handler 把它与调用侧 signal 组合喂给调度器。 */
  readonly signal: AbortSignal;
  /** 触发熔断的 id（typed 说明用）；未熔断为 undefined。 */
  readonly trippedBy: string | undefined;
}

/**
 * 每次 `run_graph` handler 调用新建一个 fuse（单次调用生命周期）。
 * plain Kahn 路径（无失败边）不装 —— 阶段 1 不触发（SC9）。
 */
export function createEffortFuse(): EffortFuse {
  const counts = new Map<string, number>();
  const controller = new AbortController();
  let trippedBy: string | undefined;
  return {
    enter(id: string): boolean {
      if (controller.signal.aborted) return false;
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      if (n > EFFORT_FUSE_THRESHOLD) {
        trippedBy = id;
        controller.abort();
        return false;
      }
      return true;
    },
    signal: controller.signal,
    get trippedBy(): string | undefined {
      return trippedBy;
    },
  };
}
