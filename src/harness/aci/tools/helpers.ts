import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { ToolExecutionError } from "../../errors.js";
import { isTaskWorktreePath } from "../../isolation/worktree-gate.js";
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
 * bash / write-tool description pair (ADR-0092). Scratch work goes to the
 * session tmp dir — the identity's own host directory, named by the static
 * `$TMPDIR` reference (the path itself is per-identity dynamic). It is not a
 * delivery destination, and guest Linux `/tmp` is no longer an alias for it.
 */
export const FENCE_WRITE_GUIDANCE =
  "Write into the project at taskRoot. Write scratch files that need not enter the repo into the session tmp dir ($TMPDIR — same lifetime as the current identity, not a delivery destination).";

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
 * T4 (plans/session-fg-handoff-interrupt.md Locked sentence 4): the model
 * sometimes echoes the live tree's own leaf prefix onto a workspace-relative
 * path — `ai-news-digest/index.html` while the tree root already IS
 * `<…>/.iknow/worktrees/ai-news-digest` — which resolves to a matryoshka
 * `ai-news-digest/` directory (the exact _Avoid_ in CONTEXT's taskRoot entry).
 * Strip that echo before resolution so both arms land on the tree root.
 *
 * Only for task-worktree-shaped roots (`isTaskWorktreePath`, shape SSOT):
 * a main checkout — or any non-worktree root — keeps today's byte-identical
 * resolution. The strip is unconditional for a leaf-prefixed path; a real
 * same-named nested directory gets no escape hatch. Only the prefix form
 * (`<leaf><sep>…`, or an absolute `<realRoot><sep><leaf><sep>…`) is stripped;
 * the bare leaf stays untouched. The relative arm normalizes first so a
 * `./<leaf>/…` echo cannot reach the nested decoy either; every non-matching
 * target is returned byte-identical.
 */
function stripTaskWorktreeLeafEcho(
  realRoot: string,
  expandedTarget: string
): string {
  if (!isTaskWorktreePath(realRoot)) return expandedTarget;
  const leaf = basename(realRoot);
  if (leaf.length === 0) return expandedTarget;
  // 归一化后再判前缀：`./<leaf>/…` 与 `<root>/./<leaf>/…` 都是同一句回显，
  // 归一化不许成为绕过剥叶的旁门。不匹配的目标原样返回（逐字节不变）。
  const normalized = normalize(expandedTarget);
  const echo = `${leaf}${sep}`;
  if (isAbsolute(expandedTarget)) {
    const rootEcho = `${realRoot}${sep}${echo}`;
    return normalized.startsWith(rootEcho)
      ? `${realRoot}${sep}${normalized.slice(rootEcho.length)}`
      : expandedTarget;
  }
  return normalized.startsWith(echo)
    ? normalized.slice(echo.length)
    : expandedTarget;
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
 * Extra containment roots plus optional identity pad. Prefer this object
 * over a fifth positional `tmpWriteRoot` so `resolveWithinRoot` stays ≤4
 * parameters. A third-arg array still means `extraReadRoots` (legacy).
 */
export type ResolveWithinRootOptions = {
  readonly extraReadRoots?: readonly string[];
  readonly extraWriteRoots?: readonly string[];
  readonly tmpWriteRoot?: string;
};

function isResolveOptions(
  value: readonly string[] | ResolveWithinRootOptions | undefined
): value is ResolveWithinRootOptions {
  return value !== undefined && !Array.isArray(value);
}

function normalizeResolveOptions(
  extraReadRootsOrOptions?: readonly string[] | ResolveWithinRootOptions,
  extraWriteRoots?: readonly string[]
): ResolveWithinRootOptions {
  if (isResolveOptions(extraReadRootsOrOptions)) {
    return extraReadRootsOrOptions;
  }
  return {
    extraReadRoots: extraReadRootsOrOptions,
    extraWriteRoots,
  };
}

async function resolveAbsoluteTarget(
  realRoot: string,
  expandedTarget: string,
  tmpWriteRoot?: string
): Promise<{ absoluteTarget: string; realTmpRoot?: string }> {
  const pad =
    tmpWriteRoot !== undefined && tmpWriteRoot.trim().length > 0
      ? tmpWriteRoot
      : undefined;
  // ADR-0092: the session tmp host path is an independent containment root.
  // A model-supplied guest `/tmp/...` literal is NOT aliased onto it — it
  // resolves as the OS `/tmp` path and falls through to the containment
  // error (observable rejection, never a silent double-write).
  return {
    absoluteTarget: isAbsolute(expandedTarget)
      ? resolve(expandedTarget)
      : resolve(realRoot, expandedTarget),
    realTmpRoot: pad !== undefined ? await realpath(resolve(pad)) : undefined,
  };
}

function assertContained(
  resolvedTarget: string,
  realRoot: string,
  roots: {
    readonly extraReadRoots?: readonly string[];
    readonly extraWriteRoots?: readonly string[];
    /** ADR-0092 会话 tmp 垫底（realpath 后）：既作放行写根，也作 /tmp 拒绝
     * 文案的数据源——单一通道，避免同一值经 extras 与独立参数双份传递。 */
    readonly realTmpRoot?: string;
  }
): void {
  const withinPrimary = isWithinRoot(realRoot, resolvedTarget);
  const withinReadExtras = (roots.extraReadRoots ?? []).some((r) =>
    isWithinRoot(resolve(r), resolvedTarget)
  );
  const withinWriteExtras = [
    ...(roots.extraWriteRoots ?? []),
    ...(roots.realTmpRoot !== undefined ? [roots.realTmpRoot] : []),
  ].some((r) => isWithinRoot(resolve(r), resolvedTarget));
  if (withinPrimary || withinReadExtras || withinWriteExtras) return;
  const prefix = `path outside workspace: ${resolvedTarget} not under ${realRoot}`;
  const scratchRel = relativeToOsTmpIfUnder(resolvedTarget);
  // SC4 (specs/mutate-write-contract.md / ADR-0092): guest Linux `/tmp` 不
  // alias 到会话 tmp，`/tmp/...` 目标必须在这里可观察地失败——但草稿越界
  // 不是交付越界，重试引导指向本身份展开 `$TMPDIR` 垫底绝对路径，而非
  // 「relative to the taskRoot」(plans/session-scratch-path-space.md T2)。
  // EXIT: 无垫底解析结果（read 面未接 tmpWriteRoot / legacy 调用）→ 落到
  // 下方交付越界文案，与劈分前的可观察行为逐字一致。
  if (scratchRel !== undefined && roots.realTmpRoot !== undefined) {
    throw new ToolExecutionError(
      scratchRejectionMessage(prefix, scratchRel, roots.realTmpRoot)
    );
  }
  // EXIT: 非 OS /tmp 的越界 = 交付越界 → 保持 ADR-0037 §4 (e) 的 taskRoot
  // 重试引导；写根缺席 → 退回原文案 (不崩,文案退化到 base 形态)。
  const deliveryHint =
    realRoot.length > 0
      ? ` (current write root is the live taskRoot: ${realRoot}; scratch files belong in the session tmp dir, $TMPDIR — same lifetime as this identity and not a delivery destination. Retry with a path relative to the taskRoot.)`
      : "";
  throw new ToolExecutionError(`${prefix}${deliveryHint}`);
}

/**
 * 草稿（OS `/tmp`）越界的拒绝文案。T3 (plans/session-scratch-path-space.md):
 * 仅当 `<sessionScratch>/X` 已存在时补那条 canonical 宿主路径——仍不
 * alias：不读、不写、不重定向，只是文案提示，垫底内容不变。
 */
function scratchRejectionMessage(
  prefix: string,
  scratchRel: string,
  pad: string
): string {
  const nearMiss = scratchRel.length > 0 ? join(pad, scratchRel) : undefined;
  // EXIT: 近邻存在性检查失败（existsSync 吞 EACCES/ENOENT 等）按不存在处理
  // ——绝不把不存在的路径写成「去读这个」式指引。
  if (nearMiss !== undefined && existsSync(nearMiss)) {
    return `${prefix} (guest /tmp is not aliased onto this identity's scratch area; ${nearMiss} already exists under the session tmp dir: expanded $TMPDIR is ${pad} — retry with that absolute path there.)`;
  }
  // EXIT: 有垫底但无近邻文件 → 只给展开的 $TMPDIR 绝对路径，不暗示任何
  // 具体文件存在。
  return `${prefix} (guest /tmp is not aliased onto this identity's scratch area; scratch files belong in the session tmp dir: expanded $TMPDIR is ${pad} — same lifetime as this identity and not a delivery destination.)`;
}

/**
 * T2 (plans/session-scratch-path-space.md): 判定被拒目标是否落在真实 OS tmp
 * 之下（`/tmp` 或 `tmpdir()` 展开位）。只用于拒绝文案劈分支——绝不用于放行，
 * 否则会把不 alias 的 guest `/tmp` 重新变成访问面。返回相对该 tmp 根的路径
 * （可能为空串，表示目标就是 tmp 根本身）。
 */
function relativeToOsTmpIfUnder(resolvedTarget: string): string | undefined {
  for (const osTmp of ["/tmp", resolve(tmpdir())]) {
    if (isWithinRoot(osTmp, resolvedTarget))
      return relative(osTmp, resolvedTarget);
  }
  return undefined;
}

export async function resolveWithinRoot(
  root: string,
  target: string,
  extraReadRootsOrOptions?: readonly string[] | ResolveWithinRootOptions,
  extraWriteRoots?: readonly string[]
): Promise<string> {
  const options = normalizeResolveOptions(
    extraReadRootsOrOptions,
    extraWriteRoots
  );
  const realRoot = await realpath(resolve(root));
  const { absoluteTarget, realTmpRoot } = await resolveAbsoluteTarget(
    realRoot,
    stripTaskWorktreeLeafEcho(realRoot, expandHome(target)),
    options.tmpWriteRoot
  );
  const resolvedTarget = await realpathWithMissingSuffix(absoluteTarget);
  assertContained(resolvedTarget, realRoot, {
    extraReadRoots: options.extraReadRoots,
    extraWriteRoots: options.extraWriteRoots,
    realTmpRoot,
  });
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

export function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}
