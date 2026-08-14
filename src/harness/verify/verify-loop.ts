/**
 * verify-loop 主循环 — orchestrator 层 advisor (T7, GH #128 失败自动修正闭环)。
 *
 * 形态: 包裹 run() 的 advisor (D1), 引擎零改动, 停止语义保持冻结。
 *   - 仅 StopReason=completed 触发验证 (假设 B9);
 *   - 验证命令经 runVerify 在 bwrap 沙箱执行 (假设 B7, 缺省装配与 bash 工具同款);
 *   - 注入只追加: 失败信封作为一条 user 消息 append 到 messages, 作为下一轮
 *     priorMessages; 从不伪造 tool_use 配对;
 *   - 超时 (timeoutSec 默认 600) 判"不稳定"不判"真失败" (假设 B13);
 *   - 用户 abort 终止整个闭环, 消息历史符合 in-flight closeout (假设 B12);
 *   - exec 启动失败 (spawn error / 沙箱拒绝) → exit=127 → 真失败分支;
 *   - 未配 verify.command + 未装配分类器 seam → 透明关闭, 行为与裸 run 逐字节
 *     一致 (SC7 既有语义, 向后兼容);
 *   - 未配 verify.command + 装配分类器 seam (runClassifier) → 子代理 LLM 判官
 *     裁决任务完成度 (spec #128 SC1/A1 填空): pass → 完成; fail → 注入分类器
 *     信封继续; abort/transport/schema 错 → unstable (SC5 fail-open)。
 *
 * 依赖方向: 只消费 verdict / inject / types 纯函数层 + sandbox 基础层,
 * 不 import 任何 ACI 装饰层, 不 import settings (配置由调用方传入 VerifyConfig)。
 *
 * runFn / runVerify 双缝注入: runFn 是 run() 的委托 (测试传 stub, 装配层传
 * 真实 run 闭包), runVerify 是验证执行体 (测试传脚本化假命令, 生产缺省
 * runInSandbox 构造)。verify-loop 不 import loop-engine 的 deps, 保持可测性。
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { HarnessStreamEvent } from "../stream.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../model-adapter/types.js";
import type { LoopTrace } from "../loop-trace.js";
import type { TraceService } from "../trace/index.js";
import { buildClassifierEnvelope, buildValidationEnvelope } from "./inject.js";
import {
  parseClassifierResult,
  truncateClassifierOutput,
} from "./classifier.js";
import {
  buildFailureSignature,
  confirmFailure,
  countFailures,
  evaluateTrend,
  type TrendResult,
} from "./verdict.js";
import type {
  ClassifierCheck,
  VerificationRecord,
  Verdict,
  VerifyConfig,
} from "./types.js";
// 沙箱执行体 (M4 拆分): RunVerifyFn / makeDefaultRunVerify / runVerifyOnce 落
// sandbox-run.ts, 本文件只做判定编排 (不 import sandbox 层)。
import {
  makeDefaultRunVerify,
  runVerifyOnce,
  type RunVerifyFn,
} from "./sandbox-run.js";

/** 验证命令超时默认 (秒); 超时判"不稳定" (假设 B13, plan §Decisions 定稿)。 */
export const DEFAULT_TIMEOUT_SEC = 600;
/** 兜底总轮数上限默认; 裁判是趋势不是计数器 (plan §Decisions 定稿)。 */
export const DEFAULT_MAX_ROUNDS = 12;

/** 单次 run() 的返回形状 (runFn 委托的返回)。 */
export type RunOutcome = {
  readonly result: RunResult;
  readonly trace: LoopTrace;
};

// RunVerifyFn 类型经 sandbox-run.ts re-export (M4 拆分), 保持 verify-loop 最小面。
export type { RunVerifyFn } from "./sandbox-run.js";

/**
 * 分类器 worker 回包信封 (spec #128 SC5)。
 * 由装配层把 SubAgentManager 的 SubAgentEnvelope 适配到此形状:
 *   - status:"ok" → result 承载判官 JSON (verify-loop 侧 parseClassifierResult);
 *   - status:"failed" → transport 错 (reason ∈ crashed/timeout/protocolError),
 *     verify-loop 收敛为 unstable (SC5 fail-open), 不注入失败信封。
 * 进程隔离 (A2) 由 seam 实现承担, verify-loop 只做编排 + 解析 + 降级。
 */
export interface ClassifierEnvelope {
  readonly status: "ok" | "failed";
  /** status:"ok" 时 = 判官 JSON; status:"failed" 时为空串。 */
  readonly result: string;
  readonly reason?:
    "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError";
  readonly summary: string;
}

/**
 * 分类器执行体 (spec #128 A2 子代理 LLM 判官 seam)。
 * 由装配层把 SubAgentManager (process-isolated worker spawn) 适配到此签名:
 *   - 生产: 构造 SubAgentDefinition → manager.spawn → manager.waitFor → 返回
 *     SubAgentEnvelope 适配成的 ClassifierEnvelope;
 *   - 测试: 注入脚本化替身。
 * spawn / envelope 协议 / 进程隔离 (A2) 由 seam 实现承担, verify-loop 只做编排。
 */
export interface RunClassifierFn {
  (args: {
    readonly task: string;
    readonly summary: string;
    readonly finalText: string | null;
    readonly signal?: AbortSignal;
    readonly cwd: string;
    /** 分类器模型槽位 (A7: settings.verify.classifierModel ?? settings.llm.model)。 */
    readonly model?: string;
  }): Promise<ClassifierEnvelope>;
}

export interface VerifyLoopOptions {
  /** run() 委托 (可注入). runFn 决定 userText 与历史续传语义。 */
  readonly runFn: (
    userText: string,
    opts?: {
      signal?: AbortSignal;
      priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
      onStream?: (event: HarnessStreamEvent) => void;
    }
  ) => Promise<RunOutcome>;
  /** 本轮任务原始 userText (闭环各轮复用同一任务文本)。 */
  readonly userText: string;
  readonly config: VerifyConfig;
  readonly sessionId: string;
  /** 用户中断信号; abort → 整个闭环终止 (in-flight closeout)。 */
  readonly signal?: AbortSignal;
  /** 观测落点 (trace 域 VerificationRecord, 每轮判定写盘, @throws never)。 */
  readonly trace?: TraceService;
  /** 验证执行体测试缝; 缺省内部用 runInSandbox 构造 (bwrap 沙箱)。 */
  readonly runVerify?: RunVerifyFn;
  /**
   * 分类器执行体 (command 缺失时的子代理 LLM 判官)。装配 → 启用分类器填空;
   * 缺席 + command 缺失 → 透明关闭 (SC7 既有语义, 向后兼容)。
   */
  readonly runClassifier?: RunClassifierFn;
  readonly cwd: string;
  readonly home?: string;
}

export type VerifyLoopOutcome =
  "passed" | "failed" | "unstable" | "escalated" | "aborted" | "disabled";

export interface VerifyLoopResult {
  /** 最终 run 结果 (通过 / 或停止时的最后状态)。 */
  readonly result: RunResult;
  readonly trace: LoopTrace;
  /** 验证轮数 (0 = 未配置不启用, 或非 completed 未触发)。 */
  readonly rounds: number;
  /** config.command 缺失 → false (透明关闭, 行为与裸 run 一致)。 */
  readonly enabled: boolean;
  readonly outcome: VerifyLoopOutcome;
  /** verify 域记录 (trace 已写盘同源)。 */
  readonly records: ReadonlyArray<VerificationRecord>;
}

/** 趋势状态 (bestFailed / lastFailed / lastSignature), 由 verify-loop 持有。 */
interface TrendState {
  bestFailed?: number;
  lastFailed?: number;
  lastSignature?: string;
}

/** 每轮验证的原始观察 (roundOutcome), 供记录 / 信封消费。 */
interface RoundObservation {
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  /** 初始验证 stdout (信封 output_excerpt 的原始输入, 截断由 inject 负责)。 */
  readonly outputText: string;
  /** 分类器分支: 判官真失败的一句立论 (A8 信封 reason 字段; 命令路径缺席)。 */
  readonly reason?: string;
  /** 分类器分支: 判官列出的缺失项 (A8 信封 missing 字段; 命令路径缺席)。 */
  readonly missing?: ReadonlyArray<string>;
  /** 分类器分支: 判官跑的 evidence 列表 (SC10 落盘 + A8 信封 evidence 字段)。 */
  readonly evidence?: ReadonlyArray<ClassifierCheck>;
}

/** 一轮验证的终态; aborted = 用户中断打断验证执行。 */
type RoundResult =
  | { readonly aborted: true }
  | ({ readonly aborted?: false } & RoundObservation);

/** 单轮验证后的闭环处置决策。 */
type RoundDecision =
  | {
      readonly kind: "pass";
      readonly recordAction: "stop";
      readonly finalOutcome: "passed";
    }
  | {
      readonly kind: "stop";
      readonly recordAction: "stop";
      readonly finalOutcome: "failed" | "unstable" | "escalated";
    }
  | { readonly kind: "continue"; readonly recordAction: "continue" }
  | { readonly kind: "escalate"; readonly recordAction: "escalate" };

/** countRegex 编译; 非法正则降级 undefined (内置失败行识别兜底, 与 verdict.ts 同纪律)。 */
function compileCountRegex(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    // // EXIT: 非法正则 → undefined, 走内置失败行识别兜底 (S3 显式退出条件)。
    return undefined;
  }
}

/** {files} 提取: 取签名 `exit=N|内容` 中 `|` 后的失败首行; 纯 exit 签名 → undefined。 */
function extractFiles(signature: string): string | undefined {
  const sep = signature.indexOf("|");
  if (sep < 0) return undefined;
  const files = signature.slice(sep + 1).trim();
  return files.length > 0 ? files : undefined;
}

/* ------------------------------ 一轮验证 (初始 + 确认阶梯) ------------------------------ */

/**
 * 一轮验证: 初始执行 → exit 0 即 pass; exit≠0 走两级确认阶梯
 * (全量复跑一次 → 失败用例单跑一次, 每级至多一次不递归, spec Glossary)。
 * 任一级超时 → unstable (不判真失败); 任一级被用户 abort → aborted。
 */
async function runVerificationRound(opts: {
  readonly command: string;
  readonly runVerify: RunVerifyFn;
  readonly timeoutSec: number;
  readonly signal?: AbortSignal;
  readonly rerunTemplate?: string;
  readonly countRegex?: string;
  /** 观测落点 + parentTurnId, 透传 runVerifyOnce 落 SandboxCmdRecord (spec:67)。 */
  readonly trace?: TraceService;
  readonly parentTurnId: string;
}): Promise<RoundResult> {
  const countRegex = compileCountRegex(opts.countRegex);

  const initial = await runVerifyOnce(opts.runVerify, opts.command, opts);
  if (opts.signal?.aborted) return { aborted: true };
  const { result: initialResult, timedOut: initialTimedOut } = initial;
  const exitCode = initialResult.exitCode;
  const outputText = initialResult.stdout;
  const failedCount = countFailures(outputText, countRegex, exitCode);
  const signature = buildFailureSignature({
    exitCode,
    outputText,
    countRegex: opts.countRegex,
  });

  if (initialTimedOut) {
    return {
      verdict: "unstable",
      exitCode,
      failedCount,
      signature,
      outputText,
    };
  }
  if (exitCode === 0) {
    return { verdict: "pass", exitCode, failedCount, signature, outputText };
  }

  // 确认阶梯第一级: 全量复跑 (同一命令再跑一次)。
  const rerun = await runVerifyOnce(opts.runVerify, opts.command, opts);
  if (opts.signal?.aborted) return { aborted: true };
  if (rerun.timedOut) {
    return {
      verdict: "unstable",
      exitCode,
      failedCount,
      signature,
      outputText,
    };
  }
  const rerunPassed = rerun.result.exitCode === 0;

  // 确认阶梯第二级: 失败用例单跑 (仅 rerunTemplate 配置且能提取出失败用例)。
  let singleRunPassed: boolean | undefined;
  const rerunTemplate = opts.rerunTemplate;
  const files =
    rerunTemplate !== undefined ? extractFiles(signature) : undefined;
  if (rerunTemplate !== undefined && files !== undefined) {
    const singleCommand = rerunTemplate.replace("{files}", files);
    const single = await runVerifyOnce(opts.runVerify, singleCommand, opts);
    if (opts.signal?.aborted) return { aborted: true };
    if (single.timedOut) {
      return {
        verdict: "unstable",
        exitCode,
        failedCount,
        signature,
        outputText,
      };
    }
    singleRunPassed = single.result.exitCode === 0;
  }

  const confirmation = confirmFailure({ rerunPassed, singleRunPassed });
  const verdict: Verdict =
    confirmation.verdict === "flaky"
      ? "pass"
      : confirmation.verdict === "unstable"
        ? "unstable"
        : "true-failure";
  return { verdict, exitCode, failedCount, signature, outputText };
}

/* ------------------------------ 处置决策 ------------------------------ */

/**
 * 单轮验证后的处置 (pure): pass / unstable → 停; true-failure → 趋势裁判。
 * 趋势放行但轮数达上限 → 耗尽处置: report → 停 (如实报告); escalate 首次 →
 * 注入升级指令并延长预算至 maxRounds*2 (总预算不重置, round 计数不断),
 * 延长期内再次耗尽 → 停 (outcome escalated)。
 */
function decideRoundAction(args: {
  readonly verdict: Verdict;
  readonly trend: TrendResult;
  readonly round: number;
  readonly maxRounds: number;
  readonly escalated: boolean;
  readonly onExhausted: "report" | "escalate" | undefined;
}): RoundDecision {
  if (args.verdict === "pass") {
    return { kind: "pass", recordAction: "stop", finalOutcome: "passed" };
  }
  if (args.verdict === "unstable") {
    return { kind: "stop", recordAction: "stop", finalOutcome: "unstable" };
  }
  if (args.trend.action === "stop") {
    return { kind: "stop", recordAction: "stop", finalOutcome: "failed" };
  }
  // true-failure + 趋势放行: 兜底轮数上限。
  const cap = args.maxRounds * (args.escalated ? 2 : 1);
  if (args.round >= cap) {
    if (args.onExhausted === "escalate" && !args.escalated) {
      return { kind: "escalate", recordAction: "escalate" };
    }
    return {
      kind: "stop",
      recordAction: "stop",
      finalOutcome: args.escalated ? "escalated" : "failed",
    };
  }
  return { kind: "continue", recordAction: "continue" };
}

/** 趋势状态推进: 仅放行轮 (action continue) 更新, 且只更新首个 best。 */
function updateTrendState(
  trend: TrendState,
  observation: RoundObservation,
  action: "continue" | "stop"
): void {
  if (action !== "continue") return;
  const current = observation.failedCount;
  if (
    trend.bestFailed === undefined ||
    (current !== undefined && current < trend.bestFailed)
  ) {
    trend.bestFailed = current;
  }
  trend.lastFailed = current;
  trend.lastSignature = observation.signature;
}

/* ------------------------------ 记录与信封构造 ------------------------------ */

/** 构造一条 verify 域 VerificationRecord (trace 域字段同构, 直接可写盘)。 */
function buildRecord(opts: {
  readonly sessionId: string;
  readonly round: number;
  readonly observation: RoundObservation;
  readonly action: "continue" | "stop" | "escalate";
  readonly finalOutcome?: string;
}): VerificationRecord {
  const { observation, action, finalOutcome } = opts;
  const record: VerificationRecord = {
    id: randomUUID(),
    sessionId: opts.sessionId,
    round: opts.round,
    verdict: observation.verdict,
    exitCode: observation.exitCode,
    ...(observation.failedCount !== undefined
      ? { failedCount: observation.failedCount }
      : {}),
    ...(observation.signature !== undefined
      ? { signature: observation.signature }
      : {}),
    // SC10: 分类器分支字段 Postel 落盘 (命令路径缺席, 不产出这些键)。
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    ...(observation.evidence !== undefined
      ? { evidence: observation.evidence }
      : {}),
    ...(observation.missing !== undefined
      ? { missing: observation.missing }
      : {}),
    action,
    ...(finalOutcome !== undefined ? { finalOutcome } : {}),
    ts: new Date().toISOString(),
  };
  return Object.freeze(record);
}

/** 注入信封作为 user 消息 (append-only, 不伪造 tool 块)。 */
function userTextMessage(text: string): AnthropicNativeMessage {
  const block: AnthropicContentBlock = { type: "text", text };
  return Object.freeze({
    role: "user",
    content: Object.freeze([block]),
  });
}

/** 是否为本轮注入的验证失败信封 (code-review High: 避免 stale 信封累积)。 */
function isValidationEnvelope(message: AnthropicNativeMessage): boolean {
  if (message.role !== "user") return false;
  return message.content.some((b) => {
    if (b.type !== "text") return false;
    return b.text.startsWith("[VALIDATION FAILED]");
  });
}

/**
 * 重建下一轮 priorMessages: 从 current.result.messages 滤除已注入的验证信封,
 * 再 append 新注入消息。避免每轮把上一轮失败信封留存在历史里 —— 模型不得
 * 重复读到已失效的旧失败上下文 (历史收敛 + closeout 不残留 stale 上下文)。
 */
function buildNextPriorMessages(
  current: RunOutcome,
  injected: AnthropicNativeMessage
): ReadonlyArray<AnthropicNativeMessage> {
  const filtered = current.result.messages.filter(
    (m) => !isValidationEnvelope(m)
  );
  return [...filtered, injected];
}

/** 升级指令 (spec 假设 B10 固定模板): 禁止重复同一修复, 换思路或明确报告阻塞。 */
function buildEscalateMessage(round: number): string {
  return `${round} attempts with the same approach failed. Do not repeat the same fix — re-read the task and take a different approach, or report the blocker explicitly.`;
}

/** 终局返回: 冻结的 VerifyLoopResult。 */
function buildResult(opts: {
  readonly current: RunOutcome;
  readonly records: ReadonlyArray<VerificationRecord>;
  readonly rounds: number;
  readonly enabled: boolean;
  readonly outcome: VerifyLoopOutcome;
}): VerifyLoopResult {
  return Object.freeze({
    result: opts.current.result,
    trace: opts.current.trace,
    rounds: opts.rounds,
    enabled: opts.enabled,
    outcome: opts.outcome,
    records: Object.freeze(opts.records.slice()),
  });
}

/* ------------------------------ 分类器分支 (command 缺失填空, spec #128) ------------------------------ */

/**
 * 单次分类器判定 (SC1 command-absent 分支执行体)。
 * 归一化规则 (spec SC5/A5):
 *   - 用户 abort → aborted;
 *   - transport 错 (status:"failed", reason ∈ crashed/timeout/protocolError)
 *     → verdict=unstable, 不注入信封 (fail-open, 不静默放行);
 *   - schema 错 (parseClassifierResult 收敛为 abort) → verdict=unstable;
 *   - {kind:"pass"} → verdict=pass;
 *   - {kind:"fail"} → verdict=true-failure + reason/missing (信封消费)。
 */
async function runClassifierOnce(opts: {
  readonly task: string;
  readonly runClassifier: RunClassifierFn;
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly model?: string;
  readonly summary: string;
  readonly finalText: string | null;
}): Promise<RoundResult> {
  let envelope: ClassifierEnvelope;
  try {
    envelope = await opts.runClassifier({
      task: opts.task,
      summary: opts.summary,
      finalText: opts.finalText,
      signal: opts.signal,
      cwd: opts.cwd,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  } catch {
    // 用户 abort 优先于 transport 归类: seam 在用户 Ctrl+C 时可能以
    // AbortError/worker 死亡 reject —— 此时必须走 in-flight abort closeout
    // (outcome=aborted), 不得按 transport 错降级为 unstable。
    if (opts.signal?.aborted) return { aborted: true };
    // // EXIT: seam throw (非用户 abort) = transport 错 → fail-open unstable,
    // 不注入失败信封 (不静默放过)。
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-transport-error",
      outputText: "",
    };
  }
  if (opts.signal?.aborted) return { aborted: true };
  if (envelope.status === "failed") {
    // // EXIT: worker 进程级失败 (crashed/timeout/protocolError) = transport 错
    // → fail-open unstable, 不注入失败信封。
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-transport-error",
      outputText: "",
    };
  }
  // SC8 运行时保证: 判官输出宿主侧截断后解析 (prompt 不写长度, A8; 截断不
  // 仅存在于 spec Check 的 grep, 而是真在 parse 前应用)。
  const parsed = parseClassifierResult(
    truncateClassifierOutput(envelope.result)
  );
  if (parsed.kind === "abort") {
    // // EXIT: schema 错 / 判官判不了 → fail-open unstable, 不注入失败信封。
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-abort",
      outputText: "",
    };
  }
  if (parsed.kind === "pass") {
    return {
      verdict: "pass",
      exitCode: 0,
      signature: undefined,
      outputText: "",
    };
  }
  // true classifier fail: 注入信封继续 (A5), 与命令路径同构的失败签名语义。
  return {
    verdict: "true-failure",
    exitCode: 1,
    failedCount: 1,
    signature: parsed.reason,
    outputText: "",
    reason: parsed.reason,
    missing: parsed.missing,
    evidence: parsed.evidence,
  };
}

/* ------------------------------ 主循环 (command 与 classifier 共用) ------------------------------ */

/**
 * 闭环主体 (command 与 classifier 两分支共用)。
 * 差异点经两枚 seam 参数化:
 *   - produceObservation: 单轮验证产出 (runVerificationRound vs runClassifierOnce);
 *   - buildFailureEnvelope: 失败信封文本 (buildValidationEnvelope vs
 *     buildClassifierEnvelope, T4 替换)。
 * 轮次模型 / 趋势判定 / maxRounds 兜底 / escalate / abort closeout 两分支同构
 * (spec #128: 分类器只是同一 advisor 的另一条验证体分支)。
 */
async function runVerifyLoopBody(opts: {
  readonly options: VerifyLoopOptions;
  readonly maxRounds: number;
  readonly sessionId: string;
  readonly produceObservation: (
    round: number,
    current: RunOutcome
  ) => Promise<RoundResult>;
  readonly buildFailureEnvelope: (
    round: number,
    maxRounds: number,
    observation: RoundObservation
  ) => string;
}): Promise<VerifyLoopResult> {
  const { options } = opts;
  const records: VerificationRecord[] = [];
  const trend: TrendState = {};
  let escalated = false;
  let current = await options.runFn(options.userText, {
    signal: options.signal,
  });
  let round = 0;

  while (true) {
    if (options.signal?.aborted) {
      return buildResult({
        current,
        records,
        rounds: round,
        enabled: true,
        outcome: "aborted",
      });
    }
    // 仅 StopReason=completed 触发验证 (假设 B9); 其余原样透传。
    if (current.result.stopReason !== "completed") {
      const outcome: VerifyLoopOutcome =
        current.result.stopReason === "cancelled" ? "aborted" : "failed";
      return buildResult({
        current,
        records,
        rounds: round,
        enabled: true,
        outcome,
      });
    }

    round += 1;
    const observation = await opts.produceObservation(round, current);
    if (observation.aborted) {
      return buildResult({
        current,
        records,
        rounds: round,
        enabled: true,
        outcome: "aborted",
      });
    }

    // 趋势判定 (裁判是趋势不是计数器); 放行时先更新状态再决定处置。
    const trendResult = evaluateTrend({
      currentFailed: observation.failedCount,
      bestFailed: trend.bestFailed,
      lastFailed: trend.lastFailed,
      currentSignature: observation.signature ?? "",
      lastSignature: trend.lastSignature,
    });
    updateTrendState(trend, observation, trendResult.action);

    const decision = decideRoundAction({
      verdict: observation.verdict,
      trend: trendResult,
      round,
      maxRounds: opts.maxRounds,
      escalated,
      onExhausted: options.config.onExhausted,
    });
    // 终态仅终局轮 (pass/stop) 有值; continue/escalate 轮无 finalOutcome。
    const finalOutcome =
      decision.kind === "pass" || decision.kind === "stop"
        ? decision.finalOutcome
        : undefined;
    records.push(
      buildRecord({
        sessionId: opts.sessionId,
        round,
        observation,
        action: decision.recordAction,
        ...(finalOutcome !== undefined ? { finalOutcome } : {}),
      })
    );
    void options.trace?.recordVerification(records[records.length - 1]!);

    if (decision.kind === "pass" || decision.kind === "stop") {
      return buildResult({
        current,
        records,
        rounds: round,
        enabled: true,
        outcome: decision.finalOutcome,
      });
    }
    if (decision.kind === "escalate") {
      escalated = true;
      current = await options.runFn(options.userText, {
        signal: options.signal,
        priorMessages: buildNextPriorMessages(
          current,
          userTextMessage(buildEscalateMessage(round))
        ),
      });
      continue;
    }

    // 普通继续: 注入验证失败信封 (append-only), 下一轮 run 携带它。
    // priorMessages 经 buildNextPriorMessages 滤除旧信封 —— 历史收敛 (High 修复)。
    const envelope = opts.buildFailureEnvelope(
      round,
      opts.maxRounds,
      observation
    );
    current = await options.runFn(options.userText, {
      signal: options.signal,
      priorMessages: buildNextPriorMessages(current, userTextMessage(envelope)),
    });
  }
}

/** command 路径的观察产出: 沙箱验证 + 确认阶梯 (M4 runVerificationRound)。 */
function produceCommandObservation(opts: {
  readonly options: VerifyLoopOptions;
  readonly command: string;
  readonly runVerify: RunVerifyFn;
  readonly timeoutSec: number;
}): (round: number, current: RunOutcome) => Promise<RoundResult> {
  const { options, command, runVerify, timeoutSec } = opts;
  return async (round, current) => {
    // parentTurnId: 触发本轮验证的 completed turn id —— 上一轮 run 的最后一条
    // turn 的 turnIndex 字符串化 (trace 域 TurnRecord 无独立 id, turnIndex 为
    // 唯一稳定锚点; plan §Decisions parentTurnId 语义)。仅 completed 才走到此,
    // 故最后一条 turn 即触发验证的 completed 回合。
    const lastTurn = current.trace.turns[current.trace.turns.length - 1];
    const parentTurnId =
      lastTurn !== undefined ? String(lastTurn.turnIndex) : `round-${round}`;
    return runVerificationRound({
      command,
      runVerify,
      timeoutSec,
      signal: options.signal,
      rerunTemplate: options.config.rerunTemplate,
      countRegex: options.config.countRegex,
      trace: options.trace,
      parentTurnId,
    });
  };
}

/** command 路径的失败信封: 既有 buildValidationEnvelope (命令字段齐全)。 */
function buildCommandFailureEnvelope(opts: {
  readonly command: string;
}): (
  round: number,
  maxRounds: number,
  observation: RoundObservation
) => string {
  const { command } = opts;
  return (round, maxRounds, observation) =>
    buildValidationEnvelope({
      round,
      maxRounds,
      verdict: "true-failure",
      command,
      exitCode: observation.exitCode,
      ...(observation.failedCount !== undefined
        ? { failedCount: observation.failedCount }
        : {}),
      ...(observation.signature !== undefined
        ? { signature: observation.signature }
        : {}),
      outputExcerpt: observation.outputText,
    });
}

/**
 * command 缺失 + 装配分类器 seam → 子代理 LLM 判官填空 (spec #128 SC1/A1)。
 * 与 command 路径同构地走 runVerifyLoopBody; summary 取 completed run 的
 * finalText 内容摘要 (判官看到的是"模型最终声称的内容", 不是 trace 锚点)。
 * 调用方 (runVerifyLoop 入口) 已保证 runClassifier 存在。
 */
function runClassifierLoop(
  options: VerifyLoopOptions & { readonly runClassifier: RunClassifierFn },
  maxRounds: number,
  sessionId: string
): Promise<VerifyLoopResult> {
  const { runClassifier } = options;
  return runVerifyLoopBody({
    options,
    maxRounds,
    sessionId,
    produceObservation: (_round, current) => {
      const summary = current.result.finalText ?? "";
      return runClassifierOnce({
        task: options.userText,
        runClassifier,
        signal: options.signal,
        cwd: options.cwd,
        ...(options.config.classifierModel !== undefined
          ? { model: options.config.classifierModel }
          : {}),
        summary,
        finalText: current.result.finalText,
      });
    },
    buildFailureEnvelope: (round, maxRounds, observation) =>
      buildClassifierEnvelope({
        round,
        maxRounds,
        task: options.userText,
        reason: observation.reason ?? "classifier reported failure",
        missing: observation.missing ?? [],
      }),
  });
}

export async function runVerifyLoop(
  options: VerifyLoopOptions
): Promise<VerifyLoopResult> {
  const command = (options.config.command ?? "").trim();
  const maxRounds = options.config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const sessionId = options.sessionId;

  // 未配 verify.command → 二选一 (A1 路径 X 独占):
  //   装配分类器 seam → 判官填空 (SC1);
  //   未装配 → 透明关闭, 只跑一次, 行为与裸 run 逐字节一致 (SC7 既有语义)。
  if (command.length === 0) {
    if (options.runClassifier !== undefined) {
      return runClassifierLoop(
        { ...options, runClassifier: options.runClassifier },
        maxRounds,
        sessionId
      );
    }
    const current = await options.runFn(options.userText, {
      signal: options.signal,
    });
    return buildResult({
      current,
      records: [],
      rounds: 0,
      enabled: false,
      outcome: "disabled",
    });
  }

  const runVerify =
    options.runVerify ??
    makeDefaultRunVerify({
      cwd: options.cwd,
      home: options.home ?? homedir(),
    });
  const timeoutSec = options.config.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  return runVerifyLoopBody({
    options,
    maxRounds,
    sessionId,
    produceObservation: produceCommandObservation({
      options,
      command,
      runVerify,
      timeoutSec,
    }),
    buildFailureEnvelope: buildCommandFailureEnvelope({ command }),
  });
}
