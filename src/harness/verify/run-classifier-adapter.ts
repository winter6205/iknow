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
import { ACI_TOOLSET_NAMES } from "../aci/tools/registry.js";

/**
 * #357 T2 — 判官 allow-list 基线（fail-closed）。
 *
 * 判官语义 = 「只许本地纯只读」：白名单三件 = read_file / grep / glob。
 *
 * 为什么用 allow-list 而不是 deny-by-category（#357 spec 357 Code Style 理由段）：
 *   - `aci.category="write"` 只覆盖 edit_file/write_file 两件，bash（execute）
 *     与 web_*（联网读）还需另写规则；
 *   - allow-list 与「只许本地纯只读」语义精确对齐；
 *   - fail-closed：ACI 扩件时判官默认拿不到新工具，除非显式加白名单
 *     （加白名单 = 显式改本常量 + operator 拍板，不接受运行时配置）。
 */
const JUDGE_ALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** 判官 role: 子代理 LLM 判官 (A4 schema 契约 prompt)。 */
const JUDGE_ROLE: SubAgentDefinitionShape = {
  role: "judge",
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
  excludeFromHostDrain: true,
  // #357 T2: deny = 全量 ACI 工具面 − 白名单基线（fail-closed allow-list 推导）。
  // 推导公式 = ACI_TOOLSET_NAMES 减 JUDGE_ALLOWED_TOOLS；不在白名单内一律禁。
  // 类型放宽为 ReadonlyArray<string>（与 SubAgentDefinition.disallowedTools 对齐），
  // 便于推导后类型兼容；as const 在 readonly tuple 与推导数组的 union 上不兼容。
  disallowedTools: (ACI_TOOLSET_NAMES as ReadonlyArray<string>).filter(
    (n) => !JUDGE_ALLOWED_TOOLS.includes(n)
  ),
  maxTurns: 2,
};

/**
 * JUDGE_ROLE 字段类型形状：role / system prompt / 工具面 deny / maxTurns。
 * 不复用 SubAgentDefinition（其字段含 task / model / timeoutMs / sandboxRoot
 * 全部可选，且这些字段由外部 opts 注入）。
 */
interface SubAgentDefinitionShape {
  readonly role: "judge";
  readonly systemPrompt: string;
  readonly disallowedTools: ReadonlyArray<string>;
  readonly maxTurns: number;
  readonly excludeFromHostDrain: true;
}

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
/**
 * #449b B6: 拼接判官任务文本 (G5-3 决议术语, SC6 task 不重绑)。
 *   - evidenceContext 缺席 → task = userText 逐字节 (既有契约);
 *   - evidenceContext 在场 → task = `<userText>\n<JSON.stringify(ctx)>`,
 *     判官从 task 单段升级到 task + 证据体检单二段, 但 task 字段语义
 *     (用户问的是什么) 未变。
 */
function buildJudgeTask(
  task: string,
  evidenceContext?: EvidenceContext
): string {
  if (evidenceContext === undefined) return task;
  return `${task}\n${JSON.stringify(evidenceContext)}`;
}

export function createRunClassifierFromManager(
  opts: CreateRunClassifierOpts
): RunClassifierFn {
  const { manager, classifierModel, timeoutMs = 120_000 } = opts;
  return async ({
    task,
    summary,
    finalText,
    signal,
    cwd,
    model,
    evidenceContext,
  }): Promise<ClassifierEnvelope> => {
    // finalText / evidenceContext are independent spawn fields.
    // They must not be concatenated into def.task (exam question = goal.text).
    // #357 code-review fix: 判官 def 不再显式传 sandboxRoot（此前锚 cwd =
    // process.cwd()）。T1 起 manager 以 parent sandboxRoot 单点校验 prefix-of-
    // parent——显式 sandboxRoot 配置（serve 路径）下 cwd ≠ parent root,判官
    // spawn 每轮被拒并静默降级为 crashed envelope。省略字段走 SC8 继承路径:
    // envelope.sandboxRoot = manager parent sandboxRoot（判官与父代理同工作域,
    // 正是判官读证据文件的正确锚）。cwd 参数保留于 RunClassifierFn 签名
    // （verify-loop 契约），adapter 当前不消费。
    void cwd;
    const def = {
      ...JUDGE_ROLE,
      // Exam question = goal.text only; evidenceContext is a separate spawn field.
      task,
      model: model ?? classifierModel,
      timeoutMs,
      ...(finalText !== null && finalText !== "" ? { finalText } : {}),
      ...(evidenceContext !== undefined ? { evidenceContext } : {}),
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
