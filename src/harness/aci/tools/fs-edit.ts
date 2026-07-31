/**
 * PROTOTYPE（throwaway）— ACI 原型 Layer 1:写入工具 fs_edit (poka-yoke linter)。
 *
 * ch04 组件③:写文件前对 new_str 跑括号/方括号/花括号/引号配对检查;不配对则
 * 拒绝落地(抛 ToolExecutionError,文件不动)。old_str 必须恰好出现一次。
 *
 * 边界:
 *   - 路径解析为绝对路径,且必须落在注入的 root 内(越界 → 错);
 *   - 不修改冻结 4-tool 协议;返回 AciToolDef 扩展层;
 *   - lintPatch 是纯函数,独立可测;供 fs_edit 调用也供单测 import。
 */

import { resolve, isAbsolute } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";

/**
 * 状态机检查 new_str 的配对情况:() [] {} 与单/双引号;含 `\\` 转义处理。
 *
 * 状态:
 *   - inString: '"' | "'" | null;进入字符串时设置,匹配同种引号(非转义)时退出;
 *   - bracketStack: 进入字符串时保留基线深度,退出后栈深度必须回齐(否则报错)。
 *
 * 规则:
 *   - 不在字符串内:遇 `"`/`'` → 进入该种字符串;遇开括号 push;遇闭括号
 *     验证栈顶匹配,否则报错;遇 `\` → 跳过下一字符(包含 `\\`);
 *   - 在字符串内:遇同种引号且未被 `\` 转义 → 退出字符串;遇 `\` → 跳过
 *     下一字符;异种引号是字面量,忽略;
 *   - 结束:inString !== null → 报错 unclosed <quote>;栈非空 → unclosed <bracket>。
 *
 * 命中 → { ok: false, reason: "..." };通过 → { ok: true }。纯函数,不依赖 IO。
 *
 * Windows 项目经验证:对 `"C:\\Users\\x\\"` 与 `"it's a test"` 这类带转义/嵌套
 * 引号的合法字面量正确放行(早期实现误把 `"` 内 `'` 当字符串开启导致误拒)。
 */
export function lintPatch(text: string): { ok: boolean; reason?: string } {
  const bracketStack: string[] = [];
  let inString: '"' | "'" | null = null;
  // 进入字符串时记录栈深度:退出字符串时栈必须回齐该深度。
  let stringBaselineDepth = 0;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (inString !== null) {
      // 字符串内
      if (ch === "\\") {
        // 跳过下一字符(`\\` `\"` `\'` `\n` 等);到达末尾则报错。
        if (i + 1 >= text.length) {
          return {
            ok: false,
            reason: `unclosed '${inString}' (trailing backslash at end of patch)`,
          };
        }
        i += 2;
        continue;
      }
      if (ch === inString) {
        // 退出字符串
        if (bracketStack.length < stringBaselineDepth) {
          return {
            ok: false,
            reason: `internal stack underflow at index ${i}`,
          };
        }
        inString = null;
        i++;
        continue;
      }
      // 异种引号 / 普通字符均忽略
      i++;
      continue;
    }

    // 不在字符串内
    if (ch === "\\") {
      // 跳过下一字符(包括 `\\`、`\"`、`\'` 等);文本末尾的孤立 `\` 也跳过。
      if (i + 1 >= text.length) {
        i++;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      stringBaselineDepth = bracketStack.length;
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      bracketStack.push(ch);
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const want = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const top = bracketStack.pop();
      if (top !== want) {
        return {
          ok: false,
          reason: `unmatched '${ch}' at index ${i} (expected '${want}', got '${top ?? "<empty>"}')`,
        };
      }
      i++;
      continue;
    }
    i++;
  }

  if (inString !== null) {
    return {
      ok: false,
      reason: `unclosed '${inString}' at end of patch`,
    };
  }
  if (bracketStack.length > 0) {
    const leftover = bracketStack[bracketStack.length - 1];
    return {
      ok: false,
      reason: `unclosed '${leftover}' at end of patch (${bracketStack.length} unmatched)`,
    };
  }
  return { ok: true };
}

/** 解析路径为绝对且验证落在 root 内。 */
function resolveWithinRoot(root: string, inputPath: string): string {
  const absRoot = resolve(root);
  const absInput = isAbsolute(inputPath) ? inputPath : resolve(absRoot, inputPath);
  // 用 normalize 后比较,防止 ../ 越界
  const normRoot = absRoot.endsWith("\\") || absRoot.endsWith("/")
    ? absRoot.slice(0, -1)
    : absRoot;
  if (absInput !== normRoot && !absInput.startsWith(normRoot + "\\") && !absInput.startsWith(normRoot + "/")) {
    throw new ToolExecutionError(
      `path escapes root: ${absInput} not under ${absRoot}`,
    );
  }
  return absInput;
}

/**
 * 工厂:createFsEditTool(root) — 写入工具,带 Linter poka-yoke。
 * 写入流程:
 *   1. 路径解析 + 越界检查;
 *   2. 读文件 → 文件不存在报错;
 *   3. lintPatch(new_str) 失败 → 拒绝落地;
 *   4. old_str 出现 0 次 → 错;>1 次 → 错;
 *   5. 写回,返回 { path(绝对), replaced: 1 }。
 */
export function createFsEditTool(root: string): AciToolDef {
  const handler = async (input: unknown): Promise<unknown> => {
    const obj = input as { path?: unknown; old_str?: unknown; new_str?: unknown };
    if (
      typeof obj?.path !== "string" ||
      typeof obj?.old_str !== "string" ||
      typeof obj?.new_str !== "string"
    ) {
      throw new ToolExecutionError("fs_edit: path, old_str, new_str must all be strings");
    }
    const absPath = resolveWithinRoot(root, obj.path);

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch (err) {
      throw new ToolExecutionError(
        `fs_edit: cannot read file: ${(err as Error).message}`,
      );
    }

    // poka-yoke:写入前 lint
    const lint = lintPatch(obj.new_str);
    if (!lint.ok) {
      throw new ToolExecutionError(`lint rejected: ${lint.reason}`);
    }

    // old_str 出现次数检查
    const occurrences = content.split(obj.old_str).length - 1;
    if (occurrences === 0) {
      throw new ToolExecutionError(`fs_edit: old_str not found in ${absPath}`);
    }
    if (occurrences > 1) {
      throw new ToolExecutionError(
        `fs_edit: old_str ambiguous: ${occurrences} occurrences in ${absPath}`,
      );
    }

    // 替换并写回(仅替换第一次出现 — split-join 必然精确一次)。
    // 注意:用 split().join() 而非 String.replace(),因为 replace 的第二参数
    // 会把 `$&` / `$1` / `$2` / `$$` 当特殊模式,会把 new_str 字面量静默损坏
    // (Standards M1);此处 old_str 已保证恰好出现 1 次,split-join 等价精确一次替换。
    const replaced = content.split(obj.old_str).join(obj.new_str);
    writeFileSync(absPath, replaced, "utf8");

    return { path: absPath, replaced: 1 };
  };

  return Object.freeze({
    name: "fs_edit",
    description:
      "Replace old_str with new_str in a file under root (linted). Returns absolute path and replaced=1 on success.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
    },
  });
}