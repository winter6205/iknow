/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：只读文件搜索。
 *
 * 验证问题：ch04 组件①（限 50 条降噪）能否以加法式装饰层实现，
 * 不修改协议、不碰产品流量。
 * 边界：递归搜索 root 下文件名/内容匹配（大小写不敏感）；
 * 忽略 node_modules / .git；所有路径解析为绝对路径；越界 → ToolExecutionError。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";

/** 忽略目录：避免 node_modules / .git 噪声（ch04 降噪）。 */
const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** 硬截断上限：50 条（ch04 组件①降噪）。 */
const MAX_RESULTS = 50;

/** target 是否在 root 内（含等于 root）。 */
function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * 在 dir 下递归收集匹配文件（文件名或内容含 pattern，大小写不敏感）。
 * 遍历全树以统计真实 total；matches 收集到 limit 条即停止追加。
 */
function collectMatches(
  dir: string,
  pattern: string,
  limit: number,
): { matches: string[]; total: number } {
  const matches: string[] = [];
  let total = 0;
  const lowerPattern = pattern.toLowerCase();

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // 不可读目录跳过
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // 不可 stat 跳过
      }
      if (isDir) {
        walk(full);
        continue;
      }
      const nameHit = entry.toLowerCase().includes(lowerPattern);
      let contentHit = false;
      if (!nameHit) {
        try {
          contentHit = readFileSync(full, "utf8")
            .toLowerCase()
            .includes(lowerPattern);
        } catch {
          // 不可读文件跳过内容匹配
        }
      }
      if (nameHit || contentHit) {
        total++;
        if (matches.length < limit) {
          matches.push(resolve(full));
        }
      }
    }
  };

  walk(dir);
  return { matches, total };
}

/**
 * 工厂：创建 fs_search 工具（ch04 组件①：限 50 条降噪）。
 * root 是沙箱根；所有返回路径为绝对路径；请求 path 越出 root → ToolExecutionError。
 */
export function createFsSearchTool(root: string): AciToolDef {
  const resolvedRoot = resolve(root);

  return Object.freeze({
    name: "fs_search",
    description:
      "Recursively search file names and contents under a root directory. Returns up to 50 absolute-path matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only" as const,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
    },
    handler: async (input: unknown) => {
      const { pattern, path: subPath, limit: rawLimit } = input as {
        pattern?: unknown;
        path?: unknown;
        limit?: unknown;
      };
      if (typeof pattern !== "string") {
        throw new ToolExecutionError("fs_search: pattern must be string");
      }
      const limit = Math.min(
        typeof rawLimit === "number" && rawLimit > 0
          ? Math.floor(rawLimit)
          : MAX_RESULTS,
        MAX_RESULTS,
      );
      const searchRoot =
        typeof subPath === "string"
          ? resolve(resolvedRoot, subPath)
          : resolvedRoot;
      if (!isWithinRoot(searchRoot, resolvedRoot)) {
        throw new ToolExecutionError(
          `fs_search: path escapes root: ${String(subPath)}`,
        );
      }
      const { matches, total } = collectMatches(searchRoot, pattern, limit);
      return { matches, truncated: total > matches.length, total };
    },
  });
}
