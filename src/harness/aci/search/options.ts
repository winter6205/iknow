/**
 * flag 解析 / 校验（SC12 第一职责；契约 D2–D5）。
 *
 * 与 handler 分开：本模块只做「unknown → 规范化 QuerySpec」+ typed 拒绝，
 * 不碰 fs、不碰进程、不拼 argv。schema 之外的第二道防线（schema 缺席 /
 * 直呼工具时仍 fail-closed）。
 */

import { ToolExecutionError } from "../../errors.js";
import { assertValidGlob } from "./glob-match.js";
import type { GrepOutput, QuerySpec } from "./types.js";

/** D3：默认 50、硬顶 2000（ADR-0006 Amendment）。 */
export const DEFAULT_HEAD_LIMIT = 50;
export const MAX_HEAD_LIMIT = 2000;

/** D5：`also` 在场时行窗默认半径。 */
export const DEFAULT_WITHIN_LINES = 5;

/** `context` 硬顶：与单行截断同量级，防止一次请求把上下文撑爆。 */
export const MAX_CONTEXT = 50;

const OUTPUTS: ReadonlyArray<GrepOutput> = ["paths", "content", "count"];

/**
 * 把 handler input 解析为 QuerySpec。
 *
 * 非法输入一律 typed 拒绝（SC10 的两种 typed 错误之一：**输入**类）。
 * 坏正则与未知 `type` 在各自的编译器里另报（不可混为一种）。
 */
export function parseQuerySpec(input: unknown): QuerySpec {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("grep: input must be an object");
  }
  const raw = input as Record<string, unknown>;
  const pattern = readNonEmptyString(raw.pattern, "pattern");
  const also = readOptionalNonEmptyString(raw.also, "also");
  const glob = readOptionalNonEmptyString(raw.glob, "glob");
  // 坏 glob 必须在入口就挡下（不是只在 Node 引擎里当字面量）：rg 对它是
  // rc=2 整次失败，两条引擎的成败不能取决于谁在跑（SC9）。
  if (glob !== undefined) assertValidGlob(glob);
  const type = readOptionalNonEmptyString(raw.type, "type");
  const output = readOutput(raw.output);
  const context = readBoundedInteger(raw.context, "context", 0, MAX_CONTEXT, 0);
  const offset = readBoundedInteger(
    raw.offset,
    "offset",
    0,
    Number.MAX_SAFE_INTEGER,
    0
  );
  const rawHeadLimit = readBoundedInteger(
    raw.head_limit,
    "head_limit",
    1,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_HEAD_LIMIT
  );
  const withinLines =
    also === undefined
      ? DEFAULT_WITHIN_LINES
      : readBoundedInteger(
          raw.within_lines,
          "within_lines",
          0,
          Number.MAX_SAFE_INTEGER,
          DEFAULT_WITHIN_LINES
        );
  return {
    pattern,
    ...(also !== undefined ? { also } : {}),
    withinLines,
    ignoreCase: raw.ignoreCase === true,
    output,
    context: output === "content" ? context : 0,
    ...(glob !== undefined ? { glob } : {}),
    ...(type !== undefined ? { type } : {}),
    offset,
    headLimit: Math.min(rawHeadLimit, MAX_HEAD_LIMIT),
  };
}

/** `limit` 已退役：出现即 typed 拒绝，把旧名误导挡在入口（D3）。 */
export function rejectRetiredLimitField(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  if ((input as Record<string, unknown>).limit !== undefined) {
    throw new ToolExecutionError(
      "grep: `limit` is not a grep parameter; the result-list count is `head_limit` (read_file uses `limit` for its line window)"
    );
  }
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError(`grep: ${name} must be a non-empty string`);
  }
  return value;
}

function readOptionalNonEmptyString(
  value: unknown,
  name: string
): string | undefined {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, name);
}

function readOutput(value: unknown): GrepOutput {
  if (value === undefined) return "paths";
  if (typeof value !== "string" || !OUTPUTS.includes(value as GrepOutput)) {
    throw new ToolExecutionError(
      `grep: output must be one of ${OUTPUTS.join(" / ")}`
    );
  }
  return value as GrepOutput;
}

function readBoundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ToolExecutionError(
      `grep: ${name} must be an integer >= ${String(min)}`
    );
  }
  return Math.min(value, max);
}
