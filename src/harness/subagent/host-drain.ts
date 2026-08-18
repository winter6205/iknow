/**
 * #356 T7 / #361 C2·C4 — host drain: 在 chat / tui / serve 三入口的 run() 边界之间,
 * 把 SubAgentManager buffer 内 completed 任务浓缩成 user message 字符串,拼入
 * 下一次 run() 的 priorMessages。
 *
 * 关键纪律 (spec SC7 / OQ5 / 契约 C2·C4):
 *   - 空 manager (undefined) / 无任务 → 返回 "";
 *   - 任一 completed → 立即返回拼接结果(不等其它 running);
 *   - 仅 running → 每 pollMs(默认 100)轮询,至 ≥1 个任务到终态返回,或
 *     timeoutMs(默认 30_000)耗尽返回 ""(超时守卫静默返 "",不抛 ——
 *     异步臂不得砸掉下一轮);
 *   - **drain 永不抛**:任何内部 waitFor 拒绝(abort/timeout/shutdown)都被
 *     catch 视为终态 → 停止轮询、返回已完成的部分结果或 "";
 *   - 不修改 manager buffer 状态 (OQ5 buffer 永久缓存直到 shutdown);
 *   - 单 task 浓缩格式:
 *       ## Sub-agent <taskId> result: <summary>
 *
 *       [result]
 *     多 task 用空行分隔。
 *
 * 实现约束 (契约 C4):优先用 drainCompleted()/listActive() 取结果;仅当需等待时
 * 走 waitFor 并以 try/catch 包住——拒绝即终态。
 *
 * ask 入口无 manager → 不调本函数 → 不行为变化。
 */
import type { SubAgentManager } from "./manager.js";

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
  /** 轮询间隔(仅 running 时),默认 100ms。 */
  readonly pollMs?: number;
  /** 仅 running 时的总等待上限,默认 30_000ms。耗尽静默返 ""。 */
  readonly timeoutMs?: number;
}

/**
 * 浓缩 completed 子代理结果为一条 user message 字符串。
 *
 * #361 C2: 从 T7 同步形态升级为异步阻塞轮询。返回 "" 当:
 *   - manager 为 undefined (ask 入口形态);
 *   - manager 内无任务 / 无 completed 且等待超时;
 *   - 等待期间 waitFor 拒绝且无已完成部分(C4,永不抛)。
 *
 * 返回的字符串可直接作为一条 user message 的 text 内容,拼入
 * run({priorMessages}) 的 priorMessages 末尾。
 */
export async function drainPendingSubagents(
  manager: SubAgentManager | undefined,
  opts?: DrainPendingSubagentsOpts
): Promise<string> {
  if (manager === undefined) return "";

  const drainCompleted = (): string => {
    const list = manager!.drainCompleted();
    if (list.length === 0) return "";
    return list
      .map(
        ({ taskId, envelope }) =>
          `${SUBAGENT_DRAIN_PREFIX}${taskId} result: ${envelope.summary}\n\n${envelope.result}`
      )
      .join("\n\n");
  };

  // 先取已 completed(含 running 场景下已完成项:立即返回,不等 running)。
  const done = drainCompleted();
  if (done) return done;

  // 无任务(empty buffer / 全 failed)→ 立即 ""。
  const active = manager.listActive();
  if (active.length === 0) return "";

  // 仅 running → 每 pollMs 轮询,至 ≥1 终态返回或 timeoutMs 耗尽返 ""。
  // 阻塞用 waitFor(firstActive, remaining) —— resolve 视为该任务到终态,
  // reject 视为终态/abort/超时。永不 throw。
  const started = Date.now();
  const pollMs = opts?.pollMs ?? 100;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  while (true) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return "";
    const remaining = timeoutMs - elapsed;
    const activeNow = manager.listActive();
    if (activeNow.length === 0) return drainCompleted();
    try {
      await manager.waitFor(
        activeNow[0]!,
        Math.min(pollMs, remaining),
        undefined
      );
      // resolve:首个活动任务到终态 → 重新枚举 drainCompleted。
      const partial = drainCompleted();
      if (partial) return partial;
      // 该任务终态但非 completed(failed) → 下一轮继续等其它任务 / 检测超时。
    } catch {
      // #361 C4: waitFor 拒绝(abort/timeout/shutdown)视为终态 ——
      // 停止轮询、返回已完成部分;永不 throw。
      const partial = drainCompleted();
      return partial;
    }
  }
}
