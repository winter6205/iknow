/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：有状态文件查看器。
 *
 * 验证问题：ch04 组件②（有状态翻页）能否以工厂闭包实现跨调用位置记忆，
 * 不修改协议、不碰产品流量。
 * 边界：一次返回 100 行；offset 缺省时若 path===lastPath 则续读，否则从 0；
 * 路径越界 / 文件不存在 → ToolExecutionError；按 \n 切，去掉行尾 \r（兼容 \r\n）。
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";

/** 每次返回的行数上限（ch04 组件②）。 */
const PAGE_SIZE = 100;

/** target 是否在 root 内（含等于 root）。 */
interface IsWithinRootOpts {
  readonly target: string;
  readonly root: string;
}

function isWithinRoot(opts: IsWithinRootOpts): boolean {
  return opts.target === opts.root || opts.target.startsWith(opts.root + sep);
}

/**
 * 工厂：创建 fs_view 工具（ch04 组件②：有状态翻页）。
 * 闭包持有 lastPath / lastOffset，实现跨调用续读。
 */
export function createFsViewTool(root: string): AciToolDef {
  const resolvedRoot = resolve(root);
  let lastPath: string | null = null;
  let lastOffset = 0;

  return Object.freeze({
    name: "fs_view",
    description:
      "View a file page by page (100 lines per call). Omit offset to continue reading the same file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
      },
      required: ["path"],
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
      const { path: rawPath, offset: rawOffset } = input as {
        path?: unknown;
        offset?: unknown;
      };
      if (typeof rawPath !== "string") {
        throw new ToolExecutionError("fs_view: path must be string");
      }
      const absPath = resolve(resolvedRoot, rawPath);
      if (!isWithinRoot({ target: absPath, root: resolvedRoot })) {
        throw new ToolExecutionError(`fs_view: path escapes root: ${rawPath}`);
      }
      let isFile = false;
      try {
        isFile = statSync(absPath).isFile();
      } catch {
        throw new ToolExecutionError(`fs_view: file not found: ${rawPath}`);
      }
      if (!isFile) {
        throw new ToolExecutionError(`fs_view: not a file: ${rawPath}`);
      }
      // offset 决策：显式传入则用；缺省时若 path===lastPath 则续读，否则从 0
      const offset =
        typeof rawOffset === "number" && rawOffset >= 0
          ? Math.floor(rawOffset)
          : absPath === lastPath
            ? lastOffset
            : 0;
      const content = readFileSync(absPath, "utf8");
      const allLines = content.split("\n").map((l) => l.replace(/\r$/, ""));
      const lines = allLines.slice(offset, offset + PAGE_SIZE);
      const to = offset + lines.length;
      const eof = to >= allLines.length;
      // 更新闭包状态（有状态：ch04 组件②）
      lastPath = absPath;
      lastOffset = to;
      return { path: absPath, lines, from: offset, to, nextOffset: to, eof };
    },
  });
}
