/**
 * verify bounded context — 类型契约 (GH #128 失败自动修正闭环, T3)。
 *
 * 命名与字段按 plans/128-auto-correction-loop.md §Decisions 定稿
 * (原 spec Open Questions 的两处 Ask-first 项)。
 * 语义来源: specs/128-auto-correction-loop.md Glossary。
 */

/** 三态判定: 验证结果归并。unstable = 全量挂但单跑过 (套件干扰)。 */
export type Verdict = "pass" | "true-failure" | "unstable";

/**
 * 分类器子代理（#128 verify 分类器）单条证据：判官跑了什么 + 跑出了什么。
 * 无 command 的 check 算 skip 不算 pass（spec A4）。
 */
export interface ClassifierCheck {
  readonly command: string;
  readonly output?: string;
  readonly result: "pass" | "fail";
}

/**
 * 分类器三态联合 (spec A4 + Code Style)。
 *  - pass：判官认为任务完成（含非空 evidence）；
 *  - fail：判官认为任务未完成，列出 missing（spec A8 信封消费 missing[]）；
 *  - abort：判官跑完了但判不了——transport / schema 错 / pass+空 evidence 静默降级
 *    都映射到此态（"判官判不了"，不是任务失败）。
 *
 * 降级规则：`{kind:"pass", evidence:[]}` 在 verify-loop 内部被 parseClassifierResult
 * 静默改写为 abort（reason 补"证据缺失"）；子代理 prompt 显式禁止该写法。
 */
export type ClassifierResult =
  | {
      readonly kind: "pass";
      readonly reason: string;
      readonly evidence: readonly ClassifierCheck[];
    }
  | {
      readonly kind: "fail";
      readonly reason: string;
      readonly missing: readonly string[];
      readonly evidence: readonly ClassifierCheck[];
    }
  | { readonly kind: "abort"; readonly reason: string };

/** 确认阶梯结果 (confirmFailure)。flaky = 全量复跑过, 放行不修正。 */
export type ConfirmationVerdict = "flaky" | "unstable" | "true-failure";

/**
 * 趋势判定结果 (evaluateTrend)。
 * oscillation-tolerant = 单轮退化但未到连续两轮, 放行一次。
 */
export type TrendVerdict =
  "progress" | "stuck" | "regression" | "oscillation-tolerant";

/** 趋势判定对闭环的处置建议。 */
export type TrendAction = "continue" | "stop";

/**
 * settings.verify 段解析结果 (ADR-0015 单承载)。
 * command 必填才启用闭环; 其余字段带默认值 (settings 层落, 见 plan §Decisions)。
 */
export interface VerifyConfig {
  readonly command: string;
  /** 失败用例单跑模板, {files} 占位; 未配则跳过确认阶梯第二级。 */
  readonly rerunTemplate?: string;
  /** 失败数提取覆盖 (正则, 首个捕获组); 优先于内置失败行识别。 */
  readonly countRegex?: string;
  /** 验证命令超时秒数, 默认 600; 超时判"不稳定" (假设 B13)。 */
  readonly timeoutSec?: number;
  /** 修正耗尽处置, 默认 report (停止+如实报告)。 */
  readonly onExhausted?: "report" | "escalate";
  /** 兜底总轮数上限, 默认 12; 裁判是趋势不是计数器。 */
  readonly maxRounds?: number;
  /**
   * 分类器 (command 缺失时的子代理 LLM 判官) 模型槽位 (A7)。
   * 显式指定时用其值; 缺省解析到 settings.llm.model。ADR-0015 扩展,
   * 非空串才合法, 代码层不硬编码模型 ID。
   */
  readonly classifierModel?: string;
}

/**
 * 每轮判定落 TraceService 的记录 (plan §Decisions 定稿字段)。
 * action 表达对闭环的处置; finalOutcome 仅终局轮有值。
 */
export interface VerificationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly round: number;
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  readonly action: "continue" | "stop" | "escalate";
  readonly finalOutcome?: string;
  readonly ts: string;
  /**
   * 分类器分支字段 (spec A4 / SC10, #128 verify 分类器)。
   * command 缺失时由子代理判官填写, 与命令路径字段并存:
   *  - reason — 判官的一句话立论 (三态均含);
   *  - evidence — 判官跑了什么 + 跑出了什么 (pass/fail 必有非空 evidence,
   *    abort 无 evidence);
   *  - missing — fail 时判官列出的未完成项 (pass/abort 无此字段)。
   * Postel: 可选字段仅存在时落盘, JSON.stringify 自动丢弃 undefined。
   * 命令路径记录 (不含这些字段) 保持原样, 无回归。
   */
  readonly reason?: string;
  readonly evidence?: readonly ClassifierCheck[];
  readonly missing?: readonly string[];
}
