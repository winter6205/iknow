/**
 * ACI Layer 1: edit_file (poka-yoke linter, split-join replacement).
 *
 * 工具层重写（#141）— 契约真值见
 * `docs/adr/0004-tool-layer-six-tool-set.md` L17 与 plans/141-tool-layer-rewrite.md
 * T1-4 / T9 裁定:
 *   - 保留 poka-yoke linter (`lintPatch` 来自 helpers);
 *   - 新增 `replace_all`(默认 false);
 *   - 替换一律 `split(old).join(new)` —— 严禁 `String.replace` 正则语义,
 *     防 `$&` / `$1` / `$$` 静默特殊化(Standards M1);
 *   - 写入前 lint(new_str) 失败 → 拒绝且不落盘;
 *   - 错误文案固定:`[edit_file] old_str not found: <path>` /
 *     `[edit_file] old_str matched N times, provide more context or set replace_all`。
 */

import { readFile, writeFile } from "node:fs/promises";

import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";
import {
  asToolExecutionError,
  lintPatch,
  resolveWithinRoot,
} from "./helpers.js";

const TOOL_NAME = "edit_file";

/**
 * 可选接缝:写盘成功后回调,参数为被修改文件的绝对路径。
 * 供外层(如 LSP notifier)做失效通知;仅成功路径触发,失败不触发避免误通知。
 */
export interface EditFileOpts {
  readonly onEdit?: (file: string) => void;
}

const ALLOWED_KEYS = new Set(["path", "old_str", "new_str", "replace_all"]);

interface EditFileInput {
  readonly path: string;
  readonly old_str: string;
  readonly new_str: string;
  readonly replace_all?: boolean;
}

function asEditFileInput(input: unknown): EditFileInput {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError(
      "[edit_file] input must be an object with path, old_str, new_str"
    );
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolExecutionError(`[edit_file] unknown field: ${key}`);
    }
  }
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    throw new ToolExecutionError("[edit_file] path must be a non-empty string");
  }
  if (typeof obj.old_str !== "string") {
    throw new ToolExecutionError("[edit_file] old_str must be a string");
  }
  if (obj.old_str.length === 0) {
    throw new ToolExecutionError(
      "[edit_file] old_str must be a non-empty string (refusing to match everywhere)"
    );
  }
  if (typeof obj.new_str !== "string") {
    throw new ToolExecutionError(
      '[edit_file] new_str must be a string (use "" to delete)'
    );
  }
  const replaceAll = obj.replace_all;
  if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
    throw new ToolExecutionError("[edit_file] replace_all must be a boolean");
  }
  return {
    path: obj.path,
    old_str: obj.old_str,
    new_str: obj.new_str,
    replace_all: replaceAll ?? false,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

function replaceOnce(haystack: string, oldStr: string, newStr: string): string {
  // 禁止 String.replace 正则语义(防 $& 特殊化):只切第一刀再拼回。
  const firstSplit = haystack.indexOf(oldStr);
  if (firstSplit < 0) return haystack;
  return (
    haystack.slice(0, firstSplit) +
    newStr +
    haystack.slice(firstSplit + oldStr.length)
  );
}

/**
 * 工厂:createEditFileTool(root) — 写入工具,带 poka-yoke linter。
 * 行为:
 *   1. resolveWithinRoot(root, path)(symlink 逃逸拒绝);
 *   2. 读文件(必须存在,否则报错);
 *   3. lintPatch(new_str) 失败 → 拒绝且不落盘;
 *   4. old_str 出现 0 次 → 失败文案`[edit_file] old_str not found: <path>`;
 *   5. replace_all=false 且 >1 次 → 失败文案`[edit_file] old_str matched N times, provide more context or set replace_all`;
 *   6. 替换(split-join / split+slice)→ 写回 → 返回确认纯字符串。
 */
export function createEditFileTool(
  root: string,
  opts?: EditFileOpts
): AciToolDef {
  const handler = async (input: unknown): Promise<unknown> => {
    const validated = asEditFileInput(input);
    const absPath = await resolveWithinRoot(root, validated.path);

    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      throw asToolExecutionError("[edit_file] cannot read file", err);
    }

    // poka-yoke:写入前 lint(new_str) — 失败则拒绝且不落盘。
    const lint = lintPatch(validated.new_str);
    if (!lint.ok) {
      throw new ToolExecutionError(`[edit_file] lint rejected: ${lint.reason}`);
    }

    // 计数 old_str 出现次数 —— 必须先于写盘。
    const occurrences = countOccurrences(content, validated.old_str);
    if (occurrences === 0) {
      throw new ToolExecutionError(`[edit_file] old_str not found: ${absPath}`);
    }
    if (occurrences > 1 && !validated.replace_all) {
      throw new ToolExecutionError(
        `[edit_file] old_str matched ${occurrences} times, provide more context or set replace_all`
      );
    }

    // split-join 等价精确替换(单处/多处均如此),无 String.replace 正则语义。
    const replaced = validated.replace_all
      ? content.split(validated.old_str).join(validated.new_str)
      : replaceOnce(content, validated.old_str, validated.new_str);
    await writeFile(absPath, replaced, "utf8");

    // 成功路径接缝:仅在写盘成功后回调。失败路径不触发,避免误通知
    // (例如 LSP notifier 已 dispose 但我们仍误告其刷新)。
    opts?.onEdit?.(absPath);

    // T4 #298 side-channel:envelope 的 output 进 model tool_result,meta
    // (old/new 全文)只走观测侧信道,不进模型可见 payload。
    return {
      output: `[edit_file] replaced ${occurrences} occurrence(s) in ${absPath}`,
      meta: { oldContent: content, newContent: replaced },
    };
  };

  return Object.freeze({
    name: TOOL_NAME,
    description:
      "Replace old_str with new_str in a file under root (linted, split-join, no regex). Set replace_all=true to replace every occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
      timeoutTier: "default" as const,
    },
  });
}
