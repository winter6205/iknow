/**
 * flag 解析 / 校验（SC12 第一职责；契约 D2–D5）。
 *
 * 与 handler 分开：本模块只做「unknown → 规范化 QuerySpec」+ typed 拒绝，
 * 不碰 fs、不碰进程、不拼 argv。schema 之外的第二道防线（schema 缺席 /
 * 直呼工具时仍 fail-closed）。
 */

import { ToolExecutionError } from "../../errors.js";
import { assertValidGlob } from "./glob-match.js";
import { resolveTypeName } from "./type-table.js";
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
  // 未知 `type` 同样必须在入口挡下 —— 但理由与坏 glob 不同：rg 自己的
  // `--type` 校验只在 argv 构造里跑，而 argv 只在**自带引擎在场**时才被走到。
  // 若把校验留在那一层，`{pattern,type:"nosuchtype"}` 在安装根缺二进制
  // （D6 降级）或该平台无资产时会静默回空串，而不是 SC10 要求的 typed 错误
  // —— 同一个输入的错误与否取决于哪条引擎在跑。校验提到解析层后，两条引擎
  // 共用同一个失败域（`resolveTypeName` 是唯一文案源）。
  const type = readOptionalNonEmptyString(raw.type, "type");
  if (type !== undefined) resolveTypeName(type);
  const output = readOutput(raw.output);
  const context = readBoundedInteger(raw.context, {
    name: "context",
    min: 0,
    max: MAX_CONTEXT,
    fallback: 0,
  });
  const offset = readBoundedInteger(raw.offset, {
    name: "offset",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });
  const rawHeadLimit = readBoundedInteger(raw.head_limit, {
    name: "head_limit",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: DEFAULT_HEAD_LIMIT,
  });
  const withinLines =
    also === undefined
      ? DEFAULT_WITHIN_LINES
      : readBoundedInteger(raw.within_lines, {
          name: "within_lines",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          fallback: DEFAULT_WITHIN_LINES,
        });
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

/**
 * 退役名 `limit` / `grep_limit`：出现即 typed 拒绝，把旧名误导挡在入口（D3）。
 *
 * 两个名字都要拦：契约写的是「不叫 `limit`，**不叫 `grep_limit`**」，
 * schema 的 `additionalProperties: false` 只保证新装配不认它，直呼工具 / 旧
 * 装配仍可能带进来 —— 只拦 `limit` 会让 `grep_limit` 静默失效（模型以为
 * 自己限了条数，实际拿到默认 50 条）。
 */
export function rejectRetiredLimitField(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  const raw = input as Record<string, unknown>;
  const retired = RETIRED_LIMIT_FIELDS.find((name) => raw[name] !== undefined);
  if (retired === undefined) return;
  throw new ToolExecutionError(
    `grep: \`${retired}\` is not a grep parameter; the result-list count is \`head_limit\` (read_file uses \`limit\` for its line window)`
  );
}

/** 退役的条数字段名（D3；文案里点名 head_limit，见上）。 */
const RETIRED_LIMIT_FIELDS: ReadonlyArray<string> = ["limit", "grep_limit"];

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

/** 整数 flag 的界（一个 flag 一份；比 5 个位置参数更难写反）。 */
interface BoundedIntegerSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/** 读一个非负整数 flag：缺席取 fallback，非整数 / 越下界 typed 拒绝，上界夹住。 */
function readBoundedInteger(value: unknown, spec: BoundedIntegerSpec): number {
  if (value === undefined) return spec.fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < spec.min
  ) {
    throw new ToolExecutionError(
      `grep: ${spec.name} must be an integer >= ${String(spec.min)}`
    );
  }
  return Math.min(value, spec.max);
}
