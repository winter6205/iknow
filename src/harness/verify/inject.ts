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
