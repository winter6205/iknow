import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { ToolExecutionError } from "../../errors.js";
// spawnWithStopSignal / truncateByCodePoint 迁至 sandbox/runner（#128 T2）：
// sandbox 是基础层，这里 re-export 保持 grep / glob / 既有测试的 import 路径不变。
export {
  SIGNAL_EXIT_CODES,
  spawnWithStopSignal,
  truncateByCodePoint,
} from "../../sandbox/runner.js";
export type {
  SpawnResult,
  SpawnWithStopSignalOptions,
  SpawnWithStopSignalResult,
} from "../../sandbox/runner.js";

/**
 * Resolve a target through symlinks and require its real location to stay under
 * the real workspace root. Missing write targets are supported by realpathing
 * the nearest existing ancestor, then appending the unresolved suffix before
 * the same containment check.
 */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Resolve a target through symlinks and require its real location to stay under
 * the real workspace root. Missing write targets are supported by realpathing
 * the nearest existing ancestor, then appending the unresolved suffix before
 * the same containment check.
 *
 * `extraReadRoots` (optional) adds additional containment roots for read-only
 * tools that legitimately need to reach outside the primary sandbox root —
 * e.g. the user profile at `~/.iknow/user.md`, which the assembly layer
 * already injects every turn but which the agent may also want to re-read
 * directly. A target is allowed if it falls under `root` OR any extra root.
 *
 * `extraWriteRoots` (optional, rev 2026-08-11): same semantics for write tools.
 * Write tools (`edit_file` / `write_file`) traditionally do NOT pass extra
 * roots, but the user-profile directory at `~/.iknow/` needs write access so
 * the agent can update `user.md` and `rm BOOTSTRAP.md` directly (replaces the
 * old `/profile done` host hook). A target is allowed if it falls under
 * `root` OR any extra root; symlink-escape is still rejected (realpath runs
 * before this check). Read and write extra roots are passed independently —
 * write tools can use `extraWriteRoots` without exposing any read roots.
 *
 * `tmpWriteRoot` (optional, parent-visible-tmp T2): host pad bound as the
 * current identity's fence `/tmp`. Guest paths under `/tmp` remap onto this
 * pad; empty `/tmp/` is typed-rejected. Absent → `/tmp` stays outside
 * (legacy / no-pad callers).
 */
export async function resolveWithinRoot(
  root: string,
  target: string,
  extraReadRoots?: readonly string[],
  extraWriteRoots?: readonly string[],
  tmpWriteRoot?: string
): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const expandedTarget = expandHome(target);
  let realTmpRoot: string | undefined;
  let absoluteTarget: string;
  if (
    tmpWriteRoot !== undefined &&
    tmpWriteRoot.trim().length > 0 &&
    isGuestTmpLiteral(expandedTarget)
  ) {
    realTmpRoot = await realpath(resolve(tmpWriteRoot));
    const remapped = remapGuestTmpOntoPad(resolve(expandedTarget), realTmpRoot);
    if (remapped === "empty") {
      throw new ToolExecutionError("empty path under /tmp");
    }
    absoluteTarget =
      remapped !== undefined ? remapped : resolve(expandedTarget);
  } else {
    absoluteTarget = isAbsolute(expandedTarget)
      ? resolve(expandedTarget)
      : resolve(realRoot, expandedTarget);
    if (tmpWriteRoot !== undefined && tmpWriteRoot.trim().length > 0) {
      realTmpRoot = await realpath(resolve(tmpWriteRoot));
    }
  }
  const resolvedTarget = await realpathWithMissingSuffix(absoluteTarget);

  const withinPrimary = isWithinRoot(realRoot, resolvedTarget);
  const withinReadExtras = (extraReadRoots ?? []).some((r) =>
    isWithinRoot(resolve(r), resolvedTarget)
  );
  const writeExtras = [
    ...(extraWriteRoots ?? []),
    ...(realTmpRoot !== undefined ? [realTmpRoot] : []),
  ];
  const withinWriteExtras = writeExtras.some((r) =>
    isWithinRoot(resolve(r), resolvedTarget)
  );
  if (!withinPrimary && !withinReadExtras && !withinWriteExtras) {
    // T3 (plans/891-taskroot-remaining-consumers.md Task 3 / ADR-0037 §4 (e)):
    // 改绑后 `root` 即活 `taskRoot` (= 写根)。模型看见的 system ## Project
    // path 仍是 `projectIdentityRoot`,但写工具失败时如果只回 `<target> not
    // under <root>`,模型很难把这两根区分开去重试一个相对路径。文案必须显式
    // 标 "current write root: <root>" 的引导,让模型能用相对路径重试。
    // SC4 (specs/mutate-write-contract.md): bash 围栏允许 /tmp(进程临时面),
    // 写工具拒绝 /tmp 是同一合同的另一面 —— 文案必须把「当前写根 = 活
    // taskRoot」「/tmp 不是交付落点」都说明,防止模型把交付物写进 /tmp。
    // 写根缺席 → 退回原文案 (不崩,文案退化到 base 形态)。
    const writeRootHint =
      realRoot.length > 0
        ? ` (current write root is the live taskRoot: ${realRoot}; /tmp is the sandbox tmpfs — process-temporary and not a delivery destination. Retry with a path relative to the taskRoot.)`
        : "";
    throw new ToolExecutionError(
      `path outside workspace: ${resolvedTarget} not under ${realRoot}${writeRootHint}`
    );
  }
  return resolvedTarget;
}

/**
 * Wrap arbitrary failures into ToolExecutionError with a stable tool prefix.
 * Single source for edit/write/read error normalization; keeps original
 * ToolExecutionError instances intact (no double-wrapping).
 */
export function asToolExecutionError(
  prefix: string,
  error: unknown
): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(`${prefix}: ${detail}`);
}

/** Migrated unchanged from fs-edit.ts; kept public for edit/write tools. */
export function lintPatch(text: string): { ok: boolean; reason?: string } {
  const bracketStack: string[] = [];
  let inString: '"' | "'" | null = null;
  let stringBaselineDepth = 0;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (inString !== null) {
      if (ch === "\\") {
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
      i++;
      continue;
    }

    if (ch === "\\") {
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

async function realpathWithMissingSuffix(target: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = target;

  while (true) {
    try {
      const existingAncestor = await realpath(candidate);
      return resolve(existingAncestor, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(relative(parent, candidate));
      candidate = parent;
    }
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

const GUEST_TMP = "/tmp";

/** Model-supplied guest `/tmp` path — not a host path that merely lives under system `/tmp`. */
function isGuestTmpLiteral(target: string): boolean {
  return target === GUEST_TMP || target.startsWith(`${GUEST_TMP}/`);
}

/**
 * Map a guest `/tmp` path onto the identity pad. `empty` = `/tmp` or `/tmp/`
 * with no filename. `undefined` = not a guest `/tmp` path.
 */
function remapGuestTmpOntoPad(
  absoluteTarget: string,
  realTmpRoot: string
): string | "empty" | undefined {
  const normalized = resolve(absoluteTarget);
  if (normalized === GUEST_TMP) return "empty";
  const prefix = `${GUEST_TMP}/`;
  if (!normalized.startsWith(prefix)) return undefined;
  const suffix = normalized.slice(prefix.length);
  if (suffix.length === 0) return "empty";
  const remapped = resolve(realTmpRoot, suffix);
  if (!isWithinRoot(realTmpRoot, remapped)) {
    throw new ToolExecutionError(
      `path outside workspace: ${remapped} not under ${realTmpRoot}`
    );
  }
  return remapped;
}
