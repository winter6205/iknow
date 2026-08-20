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
 * 分类器四态联合 (spec A4 + Code Style + #449b B7 SC7)。
 *  - pass：判官认为任务完成（含非空 evidence）；
 *  - fail：判官认为任务未完成，列出 missing（spec A8 信封消费 missing[]）；
 *  - abort：判官跑完了但判不了——transport / schema 错 / pass+空 evidence 静默降级
 *    都映射到此态（"判官判不了"，不是任务失败）；
 *  - unverified (#449b B7)：判官读完证据认为不足、拒绝猜 PASS/FAIL（G5-1 决议
 *    第 4 态，与 abort 严格区分——unverified = 判官自身的诚实停法，不是判官故障）。
 *    reason 必填非空；evidence 允许缺省（可能没跑命令所以无 evidence，与 abort
 *    同款可选纪律）；consumer 直接映射 unstable 停法（SC7/SC8，不注入信封）。
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
  | { readonly kind: "abort"; readonly reason: string }
  | { readonly kind: "unverified"; readonly reason: string };

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
  /**
   * 证据优先前级字段 (#449b B3, spec 449-evidence-checker)。
   *  - evidenceVerdict — checkEvidence 三态 verdict (B4 INSUFFICIENT 时落盘);
   *  - gamingSignals — 软信号 (断言减少 / 新增 skip / --no-verify) 仅记录不判定。
   * Postel: 可选字段仅存在时落盘, JSON.stringify 自动丢弃 undefined。
   * 命令路径记录 (不含这些字段) 保持原样, 无回归。
   */
  readonly evidenceVerdict?: EvidenceVerdict;
  readonly gamingSignals?: ReadonlyArray<string>;
}

/**
 * reason 字段判别常量 (#449b B3, typed reason 区分落盘)。
 * reason 字段本身保留 string (避免改既有解析路径), producer 写字面值,
 * consumer 用这些常量 + VerifyReasonKind 判别 (SC7: unverified ≠ abort)。
 */
export const REASON_UNVERIFIED = "unverified" as const;
export const REASON_ABORT_TYPED = "abort" as const;
/** HITL: skip completion-facing LLM judge. Not a StopReason. */
export const REASON_HITL_SKIP_COMPLETION_JUDGE =
  "hitl_skip_completion_judge" as const;

/**
 * reason 判别联合 (#449b B3, 判别用)。
 * classifier = 判官一句话立论 (既有语义, spec A4);
 * unverified / abort = B7 停法 typed reason (SC7/SC8)。
 * hitl_skip_completion_judge = 正常模式命名 EXIT (ADR-0024)。
 */
export type VerifyReasonKind =
  "classifier" | "unverified" | "abort" | "hitl_skip_completion_judge";

/**
 * evidence-checker 证据充分性判定 (spec 449-evidence-checker, G2 三态 verdict)。
 *
 * 与上方闭环轮次三态 (Verdict) 是不同域: 这是证据优先判定的确定性前级,
 * 产出对主会话 transcript 真实执行证据的判定; 调用方只消费 verdict, 不数条件。
 */
export type EvidenceVerdict =
  "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT";

/**
 * 单条 bash 测试执行的提取证据 (spec 449-evidence-checker Code Style)。
 * messageIndex = messages 数组 index, 是时效判定的时序锚
 * (R2/G4-2: 不用 mtime/diff/git, 只信会话自身工具调用顺序)。
 */
export interface TestRunEvidence {
  /** messages 数组 index (时序锚)。 */
  readonly messageIndex: number;
  /** bash tool_use input.command。 */
  readonly command: string;
  /** tool_result 结构化 JSON {code}；is_error 或无 code → null。 */
  readonly exitCode: number | null;
  /** 白名单框架 (只从框架摘要行读数字, 绝不扫描任意输出)。 */
  readonly framework: "pytest" | "jest" | "vitest" | "go" | "cargo" | null;
  /** stdout 含白名单 green 摘要行。 */
  readonly greenSummary: boolean;
  /** 弱绿: 0 tests / collected 0 / no tests found / 窄跑。 */
  readonly weakGreen: boolean;
  /** 吞失败: || true / || exit 0 / ; exit 0 / --passWithNoTests。 */
  readonly swallowed: boolean;
}

/**
 * checkEvidence 产出 (spec 449-evidence-checker Code Style)。
 * reasons 供补跑信封与 evidenceContext 消费; gamingSignals 仅记录不判定。
 */
export interface EvidenceReport {
  readonly verdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<TestRunEvidence>;
  /** 软信号 (断言减少 / 新增 skip / --no-verify) 仅记录, 不改 verdict。 */
  readonly gamingSignals: ReadonlyArray<string>;
  /** 绿证据后被代码编辑 (agent-receipts STALE 语义)。 */
  readonly stale: boolean;
}

/**
 * #449b B6: 判官输入信封附加字段 (spec 449 Code Style, G5-3 决议术语)。
 * 判官从"只看 task"升级到 task + evidenceContext 二段: task = #459 公式原样
 * (不重绑, SC6), evidenceContext = 证据体检单 (checker verdict + 不足原因 +
 * 已执行测试命令 + 补跑尝试结果 + 证据摘要, 宿主侧截断)。
 * 字段含义:
 *   - checkerVerdict — checkEvidence 三态 (SUFFICIENT / CONTRADICTED / INSUFFICIENT);
 *   - reasons — 不足 / 矛盾原因 (与 buildEvidenceRerunEnvelope Missing 段同源);
 *   - executedCommands — 已执行的 bash 测试命令列表 (report.runs.map(r => r.command));
 *   - rerunAttempted — 本轮之前是否触发过补跑 (消息扫描 [VERIFY: rerun needed] 前缀派生);
 *   - evidenceSummary — 证据摘要 (每 run 一行 command + exit + green, 走 truncateExcerpt)。
 */
export interface EvidenceContext {
  readonly checkerVerdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly executedCommands: ReadonlyArray<string>;
  readonly rerunAttempted: boolean;
  readonly evidenceSummary: string;
}
