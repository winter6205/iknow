// 依赖单向 (sandbox 基础层 ← verify 消费层): truncateByCodePoint 经
// sandbox 出口 re-export (T2 runner 迁移), 不从 ACI 装饰层拉取 ——
// 避免 verify → ACI 反向依赖 (spec Project Structure / ACR 裁决)。
import { truncateByCodePoint } from "../sandbox/index.js";

export const DEFAULT_MAX_CHARS = 20_000;

export const VALIDATION_FIXED_INSTRUCTION =
  "Fix the failures above. Do not claim completion until validation passes.";

export interface BuildValidationEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  readonly verdict: "true-failure" | "unstable";
  readonly command: string;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  /** Untruncated raw verification output. */
  readonly outputExcerpt: string;
  /** Code-point cap for the embedded output. Defaults to 20_000. */
  readonly maxChars?: number;
}

export function truncateExcerpt(text: string, maxChars: number): string {
  return truncateByCodePoint(text, maxChars);
}

export function buildValidationEnvelope(
  args: BuildValidationEnvelopeArgs
): string {
  const excerpt = truncateExcerpt(
    args.outputExcerpt,
    args.maxChars ?? DEFAULT_MAX_CHARS
  );

  const fields: string[] = [
    `[VALIDATION FAILED] attempt=${args.round}/${args.maxRounds} verdict=${args.verdict}`,
    `command: ${args.command}`,
    `exit_code: ${args.exitCode}`,
  ];
  if (args.failedCount !== undefined)
    fields.push(`failed_count: ${args.failedCount}`);
  if (args.signature !== undefined) fields.push(`signature: ${args.signature}`);

  // Keep the fixed instruction on its own line even when the raw output has no
  // trailing newline; empty output must not introduce a blank line.
  const separator = excerpt.length > 0 && !excerpt.endsWith("\n") ? "\n" : "";

  return `${fields.join("\n")}\noutput_excerpt:\n${excerpt}${separator}${VALIDATION_FIXED_INSTRUCTION}\n`;
}

/**
 * #128 verify 分类器失败信封构造器 (spec A8)。
 *
 * 与命令路径信封区别: 不携带 command / exit_code / failed_count / signature
 * (那些是命令路径字段, 分类器不掌握); 改带 task + reason + missing[]。
 *
 * 形态契约:
 *   [VALIDATION FAILED] attempt=N/M verdict=true-failure source=classifier
 *   task: <goal.text>
 *   missing: ["...", "..."]
 *   reason: <judge one-line>
 *   Fix the failures above. Do not claim completion until validation passes.
 *
 * task 内部换行折叠为单空格 —— 保持信封 fixed-shape (A8: 每个字段恰一行,
 * 多行 task 不得破坏字段解析)。reason 在 reason 字段位置走 truncateExcerpt
 * (DRY, 对齐 ADR-0006 精神)。
 */
export interface BuildClassifierEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  /** The session.goal.text (or query fallback per #408) — what the judge evaluated. */
  readonly task: string;
  /** Judge-listed missing items (fail variant). Rendered as JSON-ish array. */
  readonly missing: readonly string[];
  /** Judge's one-line 立论. Truncated via truncateExcerpt. */
  readonly reason: string;
  /** Code-point cap for the reason value. Defaults to DEFAULT_MAX_CHARS. */
  readonly maxChars?: number;
}

export function buildClassifierEnvelope(
  args: BuildClassifierEnvelopeArgs
): string {
  const truncatedReason = truncateExcerpt(
    args.reason,
    args.maxChars ?? DEFAULT_MAX_CHARS
  );

  // spec Code Style: missing 渲染为 JSON-ish 字符串数组; 空数组渲染 "[]"。
  // 顺序按上游给定顺序保留 (verifier test pins order).
  const missingJson = `[${args.missing.map((m) => JSON.stringify(m)).join(", ")}]`;

  // task 内部行终止符 (CR/LF/U+2028/U+2029) 折叠为单空格: 保持信封 fixed-shape,
  // 多行 goal.text 不产生额外字段行。
  const taskLine = args.task.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");

  const fields: string[] = [
    `[VALIDATION FAILED] attempt=${args.round}/${args.maxRounds} verdict=true-failure source=classifier`,
    `task: ${taskLine}`,
    `missing: ${missingJson}`,
    `reason: ${truncatedReason}`,
  ];

  return `${fields.join("\n")}\n${VALIDATION_FIXED_INSTRUCTION}\n`;
}

/**
 * #449b B5 补跑信封专属收尾指令 (B1 OQ1 终稿)。
 * 刻意不用 VALIDATION_FIXED_INSTRUCTION: 补跑信封语义 = "你声称完成但缺真实
 * 测试证据, 请跑命令并展示框架通过摘要", 与验证失败信封 (修正失败) 不同类。
 */
export const EVIDENCE_RERUN_FIXED_INSTRUCTION =
  "Run the command and show the test framework's green-summary line; do not claim completion until verification passes.";

export interface BuildEvidenceRerunEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  /** EvidenceReport.reasons (最多展示 5 条, 超出截 …N more 避免 envelope 膨胀)。 */
  readonly reasons: ReadonlyArray<string>;
  /** 可跑命令: config.command ?? probeVerifyCommand(...)。 */
  readonly command: string;
}

/**
 * #449b B5 补跑信封构造器 (spec Code Style / B1 OQ1 终稿逐字)。
 *
 * 形态契约:
 *   [VERIFY: rerun needed] attempt=N/M
 *   You claimed completion, but the automated evidence check did not find
 *   real test execution in the transcript.
 *   Missing:
 *   - <reason 1>
 *   - <reason 2>
 *   Run this command and include the test framework's green-summary line in
 *   your next response (e.g. "5 passed" / "Tests: 5 passed"):
 *     <command>
 *   Run the command and show the test framework's green-summary line; do not
 *   claim completion until verification passes.
 *
 * 与 [VALIDATION FAILED] 信封区分语义 (B1 决议): 补跑是证据体检后给模型一次
 * 补证据的机会, 前缀用 [VERIFY: rerun needed]; reasons 空 → 省略 Missing 段。
 */
export function buildEvidenceRerunEnvelope(
  args: BuildEvidenceRerunEnvelopeArgs
): string {
  const truncatedReasons = args.reasons.slice(0, 5);
  const lines: string[] = [
    `[VERIFY: rerun needed] attempt=${args.round}/${args.maxRounds}`,
    "You claimed completion, but the automated evidence check did not find",
    "real test execution in the transcript.",
  ];
  if (truncatedReasons.length > 0) {
    lines.push("Missing:");
    for (const reason of truncatedReasons) lines.push(`- ${reason}`);
    const extra = args.reasons.length - truncatedReasons.length;
    if (extra > 0) lines.push(`…${extra} more`);
  }
  lines.push(
    "Run this command and include the test framework's green-summary line in",
    'your next response (e.g. "5 passed" / "Tests: 5 passed"):',
    `  ${args.command}`
  );
  lines.push(EVIDENCE_RERUN_FIXED_INSTRUCTION);
  return `${lines.join("\n")}\n`;
}
