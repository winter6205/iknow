/**
 * read_file 工具（T5）— 纯无状态文件精读（#141 工具层重写）。
 *
 * 契约（ADR-0004 L14 + T1-5/T1-7 裁定）：
 *   - 输入: path (必填), offset? (默认 0, 0 基), limit? (默认 200, 上限 2000)
 *   - resolve+realpath 限定于 root 之内（symlink 越界拒绝）
 *   - 必须为文件（目录报错）；>1MB 拒绝并引导 grep+offset/limit 精读
 *   - NUL 字节 (0x00) 检测：拒绝二进制文件
 *   - 输出: 纯字符串 `${lineNo.padStart(6)}\t${line}`，行号 1 起（offset 后第一行 = offset+1）
 *   - 错误一律 throw ToolExecutionError（executor 转 execution_failed）
 *   - 工厂闭包仅持有 root，handler 无跨调用状态
 */

import { readFile, stat } from "node:fs/promises";

import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";
import { resolveWithinRoot } from "./helpers.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_FILE_BYTES = 1_048_576; // 1 MiB

export function createReadFileTool(root: string): AciToolDef {
  return Object.freeze({
    name: "read_file",
    description:
      "Read a slice of a UTF-8 text file with 1-based line numbers. Stateless; each call must supply an offset if it needs to continue. Refuses files >1MB (use grep to locate the region first) and binary files (NUL byte).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: {
          type: "integer",
          minimum: 1,
          default: DEFAULT_LIMIT,
          maximum: MAX_LIMIT,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
    handler: async (input: unknown) => {
      const params = parseInput(input);
      const resolved = await resolveWithinRoot(root, params.path);
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolExecutionError(
            `[read_file] file not found: ${resolved}`
          );
        }
        throw error;
      }
      if (info.isDirectory()) {
        throw new ToolExecutionError(
          `[read_file] not a file (is a directory): ${resolved}`
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new ToolExecutionError(
          "[read_file] file exceeds 1MB limit, locate with grep then read precisely with offset/limit"
        );
      }
      const buffer = await readFile(resolved);
      if (buffer.includes(0x00)) {
        throw new ToolExecutionError(
          `[read_file] binary file rejected: ${resolved}`
        );
      }
      const text = buffer.toString("utf8");
      return sliceLines(text, params.offset, params.limit);
    },
  });
}

interface ParsedInput {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("[read_file] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError("[read_file] path must be a non-empty string");
  }
  const offset =
    raw.offset === undefined
      ? 0
      : requireNonNegativeInteger(raw.offset, "offset");
  const limit =
    raw.limit === undefined
      ? DEFAULT_LIMIT
      : requirePositiveInteger(raw.limit, "limit");
  return {
    path: raw.path,
    offset,
    limit: Math.min(limit, MAX_LIMIT),
  };
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolExecutionError(
      `[read_file] ${name} must be a non-negative integer`
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolExecutionError(
      `[read_file] ${name} must be a positive integer`
    );
  }
  return value;
}

function sliceLines(text: string, offset: number, limit: number): string {
  if (text.length === 0) return "[read_file] ok (empty file)";
  const lines = text.split("\n");
  // Drop trailing empty element produced by a trailing newline so the
  // "last line" displayed matches the file's last newline position.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (offset >= lines.length) {
    throw new ToolExecutionError(
      `[read_file] offset ${offset} past end of file (${lines.length} lines); use a smaller offset`
    );
  }
  const window = lines.slice(offset, offset + limit);
  return window
    .map((line, idx) => `${String(offset + idx + 1).padStart(6)}\t${line}`)
    .join("\n");
}
