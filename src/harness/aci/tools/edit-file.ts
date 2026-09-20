/**
 * ACI Layer 1: edit_file (poka-yoke linter, split-join replacement).
 *
 * Contract: docs/adr/0004-tool-layer-six-tool-set.md. Rules:
 *   - keep the poka-yoke linter (`lintPatch` comes from helpers);
 *   - `replace_all` defaults to false;
 *   - every replacement goes through `split(old).join(new)` — never
 *     `String.replace`, because its regex semantics would silently
 *     special-case `$&` / `$1` / `$$` in the replacement string;
 *   - if lint(new_str) fails, refuse the edit before touching the file;
 *   - fixed failure messages:
 *     `[edit_file] old_str not found: <path>` /
 *     `[edit_file] old_str matched N times, provide more context or set replace_all`.
 */

import { readFile, writeFile } from "node:fs/promises";

import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";
import {
  asToolExecutionError,
  FENCE_WRITE_GUIDANCE,
  lintPatch,
  resolveWithinRoot,
} from "./helpers.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";

const TOOL_NAME = "edit_file";

/**
 * Optional seam: invoked after a successful write with the absolute path of
 * the modified file, so outer layers (e.g. the LSP notifier) can invalidate.
 * Fires only on the success path — failures must not trigger a bogus notice.
 */
export interface EditFileOpts {
  readonly onEdit?: (file: string) => void;
  readonly tmpDir?: string;
  readonly projectDir?: string;
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
  // Avoid String.replace's regex semantics ($& special-casing): slice at the
  // first occurrence and stitch the pieces back around the new string.
  const firstSplit = haystack.indexOf(oldStr);
  if (firstSplit < 0) return haystack;
  return (
    haystack.slice(0, firstSplit) +
    newStr +
    haystack.slice(firstSplit + oldStr.length)
  );
}

/**
 * Snapshot the live root at handler invocation time. Accepts either a literal
 * path (legacy / forward-compat shape — tests and other one-shot callers pass
 * `string`) or a `LiveTaskRoot` cell (the registry threads the cell so that a
 * `worktree rebind` in the same run reaches this handler). The returned
 * `string` is the snapshot value — the cell must be read at most once per
 * handler call, so callers reuse the snapshot for both resolve and write.
 */
function readRoot(root: string | LiveTaskRoot): string {
  return typeof root === "string" ? root : root.read();
}

/**
 * Factory: createEditFileTool(root) — write tool with a poka-yoke linter.
 * Behavior:
 *   1. resolveWithinRoot(root, path) (symlink escapes rejected);
 *   2. read the file (it must exist, else error);
 *   3. lintPatch(new_str) failure → refuse without touching disk;
 *   4. old_str occurs 0 times → `[edit_file] old_str not found: <path>`;
 *   5. replace_all=false and >1 occurrence → `[edit_file] old_str matched N
 *      times, provide more context or set replace_all`;
 *   6. replace (split-join / split+slice) → write back → confirmation string.
 *
 * `root` may also be a `LiveTaskRoot` cell: the handler reads the snapshot at
 * call time, so a `worktree rebind` in the same run lands new edits in the
 * rebound tree. `string` callers (legacy tests, one-shot consumers) keep
 * byte-identical behavior.
 */
export function createEditFileTool(
  root: string | LiveTaskRoot,
  opts?: EditFileOpts
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const validated = asEditFileInput(input);
    // Per-call snapshot: resolve and write must share the same root value.
    const rootAtCall = readRoot(root);
    const sessionTmpRoot = resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId: ctx?.conversationId,
    });
    const absPath = await resolveWithinRoot(rootAtCall, validated.path, {
      sessionTmpRoot,
    });

    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      throw asToolExecutionError("[edit_file] cannot read file", err);
    }

    // poka-yoke: lint(new_str) before writing — refuse without touching disk.
    const lint = lintPatch(validated.new_str);
    if (!lint.ok) {
      throw new ToolExecutionError(`[edit_file] lint rejected: ${lint.reason}`);
    }

    // Count old_str occurrences — must happen before any write.
    const occurrences = countOccurrences(content, validated.old_str);
    if (occurrences === 0) {
      throw new ToolExecutionError(`[edit_file] old_str not found: ${absPath}`);
    }
    if (occurrences > 1 && !validated.replace_all) {
      throw new ToolExecutionError(
        `[edit_file] old_str matched ${occurrences} times, provide more context or set replace_all`
      );
    }

    // split-join is exact replacement (single or multiple occurrences alike),
    // with no String.replace regex semantics.
    const replaced = validated.replace_all
      ? content.split(validated.old_str).join(validated.new_str)
      : replaceOnce(content, validated.old_str, validated.new_str);
    await writeFile(absPath, replaced, "utf8");

    // Success-path seam: callback fires only after the write succeeds. Failure
    // paths stay silent, so a disposed LSP notifier is never falsely told to
    // refresh.
    opts?.onEdit?.(absPath);

    // Side-channel split: the envelope's output goes into the model's
    // tool_result; meta (full old/new contents) travels only the observation
    // side-channel and never enters the model-visible payload.
    return {
      output: `[edit_file] replaced ${occurrences} occurrence(s) in ${absPath}`,
      meta: { oldContent: content, newContent: replaced },
    };
  };

  return Object.freeze({
    name: TOOL_NAME,
    description:
      "Apply a surgical in-place edit to an existing file when you have the exact `old_str` to anchor on; pair with read_file to confirm current contents before editing. Replaces old_str with new_str via split-join (no regex semantics — `$`/`&` literals pass through unchanged); lint(new_str) rejects unbalanced patches before any write. Default replace_all=false — the file must contain old_str exactly once; set replace_all=true to replace every occurrence. " +
      FENCE_WRITE_GUIDANCE,
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
