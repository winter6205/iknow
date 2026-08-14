/**
 * #128 verify 分类器 seam 装配 helper。
 *
 * spec A2 进程隔离 + A4 schema 契约的工厂: 给定 SubAgentManager + 分类器
 * 模型槽位 → 产出 RunClassifierFn, verify-loop 可直连。
 *
 * 两处生产装配入口:
 *  - src/session-api/hub.ts (serve 入口);
 *  - src/cli/chat-session.ts (chat/ask TTY);
 *
 * + scripts/i128-verify-classifier-real-llm.ts 烟雾测试复用同一工厂。
 *
 * SubAgentManager 缺席 (ask 形态) → 返回 undefined, 调用方不装配 runClassifier
 * 即可恢复透明关闭语义 (向后兼容, SC7 既有 contract)。
 *
 * 工厂内部 spawn → waitFor 协议适配为 ClassifierEnvelope (status:"ok" /
 * "failed"), 与 verify-loop 的 RunClassifierFn seam 一一对应 (verify-loop.ts:75-82)。
 */
import type { SubAgentManager } from "../subagent/manager.js";
import type { ClassifierEnvelope, RunClassifierFn } from "./verify-loop.js";

/** 判官 role: 子代理 LLM 判官 (A4 schema 契约 prompt)。 */
const JUDGE_ROLE = {
  systemPrompt:
    "You are a strict task-completion judge. Given a task, evaluate whether " +
    "the work is actually done. Output ONLY a JSON object with exactly one of " +
    "these shapes:\n" +
    '{"kind":"pass","reason":"<one-line>","evidence":[{"command":"<what you ' +
    'verified>","result":"pass"}]}\n' +
    '{"kind":"fail","reason":"<one-line>","missing":["<item>"],"evidence":[' +
    '{"command":"<what you verified>","result":"fail"}]}\n' +
    '{"kind":"abort","reason":"<one-line>"}\n' +
    "Rules: pass and fail MUST include at least one evidence item; never emit " +
    'pass with empty evidence. If you cannot determine completion, use "abort".',
  disallowedTools: [
    "bash",
    "edit_file",
    "write_file",
    "web_fetch",
    "web_search",
  ],
  maxTurns: 2,
} as const;

export interface CreateRunClassifierOpts {
  readonly manager: SubAgentManager;
  /** 分类器模型槽位 (A7: settings.verify.classifierModel ?? settings.llm.model)。 */
  readonly classifierModel?: string;
  /** 单轮超时 (ms)。缺省 120_000。 */
  readonly timeoutMs?: number;
}

/**
 * 把 SubAgentManager 适配为 RunClassifierFn:
 *   spawn judge worker → waitFor → 把 SubAgentEnvelope 收敛为 ClassifierEnvelope。
 *
 * 返回 undefined 当 manager 为 undefined (ask 形态; 调用方拿 undefined 自然
 * 走 SC7 透明关闭分支, 无需特殊 if)。
 */
export function createRunClassifierFromManager(
  opts: CreateRunClassifierOpts
): RunClassifierFn {
  const { manager, classifierModel, timeoutMs = 120_000 } = opts;
  return async ({
    task,
    summary,
    signal,
    cwd,
    model,
  }): Promise<ClassifierEnvelope> => {
    const def = {
      ...JUDGE_ROLE,
      task,
      model: model ?? classifierModel,
      timeoutMs,
      sandboxRoot: cwd,
    };
    let taskId: string;
    try {
      ({ taskId } = manager.spawn(def));
    } catch (err) {
      return {
        status: "failed",
        result: "",
        summary,
        reason: "crashed",
      };
    }
    try {
      const envelope = await manager.waitFor(taskId, timeoutMs, signal);
      if (envelope.status === "ok") {
        return { status: "ok", result: envelope.result, summary };
      }
      // 失败传输：reason 透传 (crashed/timeout/protocolError/maxTurnsExceeded)。
      return {
        status: "failed",
        result: "",
        summary,
        ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
      };
    } catch (err) {
      // AbortSignal 触发或 waitFor 超时 → transport 错 (SC5 → unstable)。
      const reason =
        err instanceof Error && err.name === "SubAgentWaitTimeoutError"
          ? "timeout"
          : "crashed";
      return { status: "failed", result: "", summary, reason };
    }
  };
}
