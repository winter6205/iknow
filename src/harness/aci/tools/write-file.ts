/**
 * ACI Layer 1: write_file — create or replace a complete file.
 *
 * The target is resolved through the shared workspace containment helper before
 * any filesystem mutation. Whole-file content is written verbatim — the
 * patch-level poka-yoke linter is only applied by edit_file, not here, so
 * legitimately-balanced content containing `{`, `]`, or unclosed quotes inside
 * comments/strings is accepted.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";
import { asToolExecutionError, resolveWithinRoot } from "./helpers.js";

const TOOL_NAME = "write_file";
const ALLOWED_KEYS = new Set(["path", "content", "create_directories"]);

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly createDirectories: boolean;
}

function parseInput(input: unknown): WriteFileInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError(
      "[write_file] input must be an object with path and content"
    );
  }

  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ToolExecutionError(`[write_file] unknown field: ${key}`);
    }
  }
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolExecutionError(
      "[write_file] path must be a non-empty string"
    );
  }
  if (typeof raw.content !== "string") {
    throw new ToolExecutionError("[write_file] content must be a string");
  }
  if (
    raw.create_directories !== undefined &&
    typeof raw.create_directories !== "boolean"
  ) {
    throw new ToolExecutionError(
      "[write_file] create_directories must be a boolean"
    );
  }

  return {
    path: raw.path,
    content: raw.content,
    createDirectories: raw.create_directories ?? true,
  };
}

function displayPath(root: string, target: string): string {
  const path = relative(resolve(root), target);
  return path === "" ? "." : path;
}

/**
 * Create or wholly overwrite a file below `root`.
 *
 * `create_directories` defaults to true and only controls parent-directory
 * creation; it never changes the whole-file replacement semantics.
 */
export function createWriteFileTool(root: string): AciToolDef {
  const handler = async (input: unknown): Promise<unknown> => {
    const params = parseInput(input);

    let target: string;
    try {
      target = await resolveWithinRoot(root, params.path);
    } catch (error) {
      throw asToolExecutionError("[write_file] cannot resolve path", error);
    }

    const parent = dirname(target);
    if (params.createDirectories) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        throw asToolExecutionError(
          `[write_file] cannot create parent directory ${parent}`,
          error
        );
      }
    } else {
      let parentInfo: Awaited<ReturnType<typeof stat>>;
      try {
        parentInfo = await stat(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new ToolExecutionError(
            `[write_file] parent directory does not exist: ${parent}`
          );
        }
        throw asToolExecutionError(
          `[write_file] cannot inspect parent directory ${parent}`,
          error
        );
      }
      if (!parentInfo.isDirectory()) {
        throw new ToolExecutionError(
          `[write_file] parent path is not a directory: ${parent}`
        );
      }
    }

    // T4 #298 side-channel:写盘前读旧内容(oldContent);文件不存在 → 空串。
    // 读失败不阻断写入(写盘才是主路径),仅降级 oldContent 为空,保证既有
    // 拒绝语义(父目录缺失 / symlink 逃逸)不受影响 — 此刻 containment 已通过。
    let oldContent = "";
    try {
      oldContent = await readFile(target, "utf8");
    } catch {
      oldContent = "";
    }

    try {
      await writeFile(target, params.content, "utf8");
    } catch (error) {
      throw asToolExecutionError(`[write_file] cannot write ${target}`, error);
    }

    const pathForMessage = displayPath(root, target);
    return {
      output: `[write_file] wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${pathForMessage}`,
      meta: { oldContent, newContent: params.content },
    };
  };

  return Object.freeze({
    name: TOOL_NAME,
    description:
      "Create a new file or fully overwrite an existing one inside the workspace root; prefer edit_file for surgical changes to an existing file. Writes verbatim UTF-8 (no template processing); parent directories auto-created unless create_directories=false. Writes outside the workspace root are out of scope.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        create_directories: { type: "boolean", default: true },
      },
      required: ["path", "content"],
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
