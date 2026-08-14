/**
 * verify 纯函数判定层 (GH #128 失败自动修正闭环, T3)。
 *
 * 三态判定 / 确认阶梯 / 失败签名 / 趋势判定 —— 全部纯函数, 零 IO 零副作用
 * (spec ACR complexity-anti-drift yes; spec:92 unit 层落点)。
 * 语义按 specs/128-auto-correction-loop.md Glossary 与 plans/128-auto-correction-loop.md
 * §Decisions; 任何状态 (bestFailed / 上轮签名 / 连续退化计数) 由调用方
 * (verify-loop) 持有并传入, 本模块不隐式记忆。
 */
import type {
  ConfirmationVerdict,
  TrendAction,
  TrendVerdict,
  Verdict,
} from "./types.js";

/** 内置失败行识别 (plan §Decisions): exit≠0 时计这些行数为 failedCount。 */
export const FAILURE_LINE_PATTERN = /^\s*(FAIL(ED)?|✗|×)\b|\berror:/i;

/* ------------------------------ 三态判定 ------------------------------ */

export interface AssessVerdictArgs {
  readonly exitCode: number;
  /** 本轮失败用例数; 无法解析时缺省。 */
  readonly failedCount?: number;
  /**
   * 确认阶梯第一级 (全量复跑) 是否通过。
   * 首次验证 (尚未复跑) 传 undefined → 视为未通过, 不凭空放行。
   */
  readonly rerunPassed?: boolean;
  /**
   * 确认阶梯第二级 (失败用例单跑) 是否通过。
   * 未配置 rerunTemplate 时缺省 → 不参与 unstable 判定。
   */
  readonly singlePassed?: boolean;
}

/**
 * 三态判定: pass / true-failure / unstable。
 * - exit 0 或失败数为 0 → pass;
 * - exit≠0 且确认阶梯全不过 → true-failure;
 * - exit≠0 且全量复跑过 → pass (flaky 放行, 不修正);
 * - exit≠0 且全量复跑仍挂但单跑过 → unstable (套件干扰, 不修正)。
 */
export function assessVerdict(args: AssessVerdictArgs): Verdict {
  const { exitCode, failedCount } = args;
  if (exitCode === 0 || failedCount === 0) return "pass";
  if (args.rerunPassed === true) return "pass";
  if (args.singlePassed === true) return "unstable";
  return "true-failure";
}

/* ------------------------------ 确认阶梯 ------------------------------ */

export interface ConfirmFailureArgs {
  /** 第一级: 全量复跑是否通过。 */
  readonly rerunPassed: boolean;
  /**
   * 第二级: 失败用例单跑是否通过。
   * 未配置 rerunTemplate 时调用方传 undefined (跳过单跑)。
   */
  readonly singleRunPassed?: boolean;
}

export interface ConfirmationLadderResult {
  readonly verdict: ConfirmationVerdict;
  /** 第一级是否失败 (全量复跑挂)。 */
  readonly rerunFailed: boolean;
  /** 第二级是否执行且通过; undefined = 未配置单跑模板。 */
  readonly singleRunPassed?: boolean;
}

/**
 * 两级确认阶梯 (Glossary: 每级至多一次不递归, 全过才判 flaky, 全不过才判真失败)。
 * 阶梯是短路链: 全量复跑过 → flaky, 不触发第二级; 全量复跑挂时再视单跑结果。
 */
export function confirmFailure(
  args: ConfirmFailureArgs
): ConfirmationLadderResult {
  if (args.rerunPassed) {
    return { verdict: "flaky", rerunFailed: false, singleRunPassed: undefined };
  }
  if (args.singleRunPassed === true) {
    return { verdict: "unstable", rerunFailed: true, singleRunPassed: true };
  }
  return {
    verdict: "true-failure",
    rerunFailed: true,
    singleRunPassed: args.singleRunPassed,
  };
}

/* ------------------------------ 失败计数 ------------------------------ */

export function countFailures(
  outputText: string,
  countRegex?: RegExp,
  exitCode?: number
): number | undefined {
  // pass 分支 (exit 0) 不数失败行 —— 失败计数只服务于失败语义。
  if (exitCode !== undefined && exitCode === 0) return 0;

  if (countRegex !== undefined) {
    const match = countRegex.exec(outputText);
    // 只认能提取出整数个数的正则; 无捕获组 / 不匹配 → 不猜测, 走纯签名路径。
    if (match !== null && match[1] !== undefined) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n >= 0) return n;
    }
    return undefined;
  }

  let count = 0;
  for (const line of outputText.split("\n")) {
    if (FAILURE_LINE_PATTERN.test(line)) count += 1;
  }
  return count;
}

/* ------------------------------ 失败签名 ------------------------------ */

export interface BuildFailureSignatureArgs {
  readonly exitCode: number;
  /** 原始验证输出; 签名提取只读其文本, 不修改调用方数据。 */
  readonly outputText: string;
  /** settings.verify.countRegex; 优先于内置失败行识别。 */
  readonly countRegex?: string;
}

/**
 * 失败签名归一 (Glossary): 退出码 + 失败用例名/首行错误。
 * 格式 `exit=1|tests/auth.test.ts:login rejects bad token`。
 * countRegex 优先 (plan §Decisions); 两者均无 → 纯 `exit=N` 签名 (仅停滞检测)。
 */
export function buildFailureSignature(args: BuildFailureSignatureArgs): string {
  const { exitCode, outputText } = args;
  const firstLine = firstFailureLine(outputText, args.countRegex);
  return firstLine === undefined
    ? `exit=${exitCode}`
    : `exit=${exitCode}|${firstLine}`;
}

/**
 * 取首个失败行行首作为签名内容。
 * 无配置 countRegex 时走内置失败行识别; 有配置时优先用其匹配行。
 */
function firstFailureLine(
  outputText: string,
  countRegex?: string
): string | undefined {
  if (countRegex !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(countRegex);
    } catch {
      // settings 层已兜底非法正则; 纯函数层无法解析时降级内置识别。
      // // EXIT: 非法正则 → 降级内置失败行识别 (S3 显式退出条件)。
      re = FAILURE_LINE_PATTERN;
    }
    const match = re.exec(outputText);
    if (match !== null) return match[0].trim();
  }

  for (const line of outputText.split("\n")) {
    if (FAILURE_LINE_PATTERN.test(line)) {
      return stripFailureMarker(line);
    }
  }
  return undefined;
}

/**
 * 剥 FAIL / FAILED / ✗ / × 前缀标记, 保留失败用例名或错误内容。
 * spec 签名示例 "exit=1|tests/auth.test.ts:login rejects bad token"
 * 不含 "FAIL  " 前缀 —— 签名内容是失败用例名, 不是行首标记。
 * error: 行保留 "error:" 前缀 (其内容本身就是首行错误文本)。
 */
function stripFailureMarker(line: string): string {
  return line.replace(/^\s*(FAIL(ED)?|✗|×)\b\s*/, "").trim();
}

/* ------------------------------ 趋势判定 ------------------------------ */

export interface EvaluateTrendArgs {
  /** 本轮失败用例数; undefined = 解析不出 (走纯签名比对)。 */
  readonly currentFailed?: number;
  /** 历史最好 (最小) 失败数。 */
  readonly bestFailed?: number;
  /** 上轮失败用例数。 */
  readonly lastFailed?: number;
  readonly currentSignature: string;
  readonly lastSignature?: string;
}

export interface TrendResult {
  readonly trend: TrendVerdict;
  readonly action: TrendAction;
}

/**
 * 趋势判定 (Glossary): 裁判是趋势不是计数器, maxRounds 仅兜底。
 * 判定顺序 = 优先级, 各规则互斥:
 * 1. 进展: current < best → continue (优于历史最好, 无条件放行);
 * 2. 停滞: 同签名连续两轮 (current == last, 签名不变) → stop;
 * 3. 回归: last > best 且 current > best (连续两轮差于最好成绩) → stop;
 * 4. 震荡宽容: current > best 但 last == best (单轮退化, 未到两轮) → continue;
 * 5. 兜底 (含失败数解析不出的轮次): 不猜停, 放行。
 */
export function evaluateTrend(args: EvaluateTrendArgs): TrendResult {
  const { currentFailed, bestFailed, lastFailed, currentSignature } = args;
  const lastSignature = args.lastSignature;

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    currentFailed < bestFailed
  ) {
    return { trend: "progress", action: "continue" };
  }

  if (
    currentFailed !== undefined &&
    lastFailed !== undefined &&
    lastSignature !== undefined &&
    lastSignature === currentSignature &&
    currentFailed === lastFailed
  ) {
    return { trend: "stuck", action: "stop" };
  }

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    lastFailed !== undefined &&
    currentFailed > bestFailed &&
    lastFailed > bestFailed
  ) {
    return { trend: "regression", action: "stop" };
  }

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    lastFailed !== undefined &&
    currentFailed > bestFailed &&
    lastFailed === bestFailed
  ) {
    return { trend: "oscillation-tolerant", action: "continue" };
  }

  return { trend: "oscillation-tolerant", action: "continue" };
}
