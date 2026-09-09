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
import type { ToolExecutionContext } from "../../tools/types.js";
import { asToolExecutionError, resolveWithinRoot } from "./helpers.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";

export interface WriteFileOpts {
  /** Explicit host pad (tests / T3 worker pad). */
  readonly tmpDir?: string;
  /** Session project dir; with `ctx.conversationId` → main-session pad. */
  readonly projectDir?: string;
}

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
 * Snapshot the live root at handler invocation time. Accepts either a literal
 * path (legacy / forward-compat shape — tests and other one-shot callers pass
 * `string`) or a `LiveTaskRoot` cell (T5: registry threads the cell so that
 * `worktree rebind` in the same run reaches this handler). The returned
 * `string` is the snapshot value — D2 forbids reading the cell more than once
 * per handler call, so callers must reuse the snapshot for both resolve and
 * write.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/**
 * Create or wholly overwrite a file below `root`.
 *
 * `create_directories` defaults to true and only controls parent-directory
 * creation; it never changes the whole-file replacement semantics.
 *
 * T5 (plans/worktree-live-task-root.md §6): `root` may be a `LiveTaskRoot`
 * cell; the handler reads the snapshot at call time, so `worktree rebind`
 * in the same run lands new writes in the rebound tree. `string` callers
 * (legacy tests, one-shot consumers) keep byte-identical behavior.
 */
export function createWriteFileTool(
  root: string | LiveTaskRoot,
  opts?: WriteFileOpts
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const params = parseInput(input);
    // T5 D2: per-call snapshot. resolve 与写入必须共用同一个根值。
    const rootAtCall = readRoot(root);
    const tmpWriteRoot = resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId: ctx?.conversationId,
    });

    let target: string;
    try {
      target = await resolveWithinRoot(
        rootAtCall,
        params.path,
        undefined,
        undefined,
        tmpWriteRoot
      );
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

    const pathForMessage = displayPath(rootAtCall, target);
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
