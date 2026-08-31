/**
 * #356 T7 / #361 C2·C4 — host drain: 在 chat / tui / serve 三入口的 run() 边界之间,
 * 把 SubAgentManager buffer 内终态任务浓缩成 user message 字符串,拼入
 * 下一次 run() 的 priorMessages。
 *
 * 关键纪律 (spec SC7 / OQ5 / 契约 C2·C4):
 *   - 空 manager (undefined) / 无任务 → 立即返回 "";
 *   - 任一终态任务 → 立即返回拼接结果,不等其它 running;
 *   - 仅 running → 立即返回 "",不在 run() 边界轮询等待;
 *   - **drain 永不抛**:manager buffer 或浓缩失败时静默返回 "";
 *   - 不修改 manager buffer 状态 (OQ5 buffer 永久缓存直到 shutdown);
 *   - 单 task 浓缩格式:
 *       ## Sub-agent <taskId> result: <summary>
 *
 *       [result]
 *     多 task 用空行分隔。
 *
 * 实现约束 (契约 C4):仅用 drainCompleted() 取结果;不调用 listActive() /
 * waitFor(),不改变 manager buffer。
 *
 * ask 入口无 manager → 不调本函数 → 不行为变化。
 */
import type { SubagentManagerDrainView } from "./manager-registry.js";
import { projectParentVisibleEnvelope } from "./envelope.js";

/**
 * Drain 消息文本前缀（SSOT）。单 task 浓缩格式为
 * `${SUBAGENT_DRAIN_PREFIX}${taskId} result: ${summary}\n\n${result}`；
 * 显示投影层（session-api turn 投影 / rewind 边界投影）用
 * `isSubagentDrainText` 识别并跳过 drain 消息，格式与谓词同源。
 */
export const SUBAGENT_DRAIN_PREFIX = "## Sub-agent ";

/** trim 后以 drain 前缀开头即判定 —— drain 消息不构成 turn / 不作 slice 边界。 */
export function isSubagentDrainText(text: string): boolean {
  return text.trim().startsWith(SUBAGENT_DRAIN_PREFIX);
}

export interface DrainPendingSubagentsOpts {
  /** Restrict the drain to workers owned by one interactive session. */
  readonly conversationId?: string;
  /** 已废弃,为保持调用方兼容而保留;host drain 不轮询。 */
  readonly pollMs?: number;
  /** 已废弃,为保持调用方兼容而保留;host drain 不等待。 */
  readonly timeoutMs?: number;
}

/**
 * 浓缩终态子代理结果为一条 user message 字符串。
 *
 * #361 C2: 后景 host drain 只消费已经完成的 buffer。返回 "" 当:
 *   - manager 为 undefined (ask 入口形态);
 *   - manager 内无任务或没有终态任务;
 *   - manager 的只读 drain / 浓缩操作失败(永不抛)。
 *
 * `_opts` 仅为兼容既有调用方保留;running worker 不会触发等待。
 */
export async function drainPendingSubagents(
  manager: SubagentManagerDrainView | undefined,
  opts?: DrainPendingSubagentsOpts
): Promise<string> {
  if (manager === undefined) return "";

  try {
    const list = manager.drainCompleted(opts?.conversationId);
    if (list.length === 0) return "";
    return list
      .map(({ taskId, envelope }) => {
        const visible = projectParentVisibleEnvelope(envelope);
        return `${SUBAGENT_DRAIN_PREFIX}${taskId} result: ${visible.summary}\n\n${visible.result}`;
      })
      .join("\n\n");
  } catch (error) {
    // EXIT: host drain is intentionally non-throwing; "" is the documented
    // no-result/degraded channel, while terminal wake failures are reported
    // separately by host-wake.
    void error;
    return "";
  }
}
