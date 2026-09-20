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
// spawnWithStopSignal / truncateByCodePoint moved to sandbox/runner:
// sandbox is the base layer; the re-export here keeps the import paths used
// by grep / glob / existing tests unchanged.
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
 * The model sometimes echoes the live tree's own leaf prefix onto a
 * workspace-relative path — `ai-news-digest/index.html` while the tree root
 * already IS `<…>/.iknow/worktrees/ai-news-digest` — which resolves to a
 * matryoshka `ai-news-digest/` directory (the exact _Avoid_ in CONTEXT's
 * taskRoot entry). Strip that echo before resolution so both arms land on
 * the tree root.
 *
 * Only for task-worktree-shaped roots (`isTaskWorktreePath`, shape SSOT):
 * a main checkout — or any non-worktree root — keeps today's byte-identical
 * resolution. The strip is unconditional for a leaf-prefixed path; a real
 * same-named nested directory gets no escape hatch. Only the prefix form
 * (`<leaf><sep>…`, or an absolute `<realRoot><sep><leaf><sep>…`) is
 * stripped; the bare leaf stays untouched. The relative arm normalizes
 * first so a `./<leaf>/…` echo cannot reach the nested decoy either; every
 * non-matching target is returned byte-identical.
 */
function stripTaskWorktreeLeafEcho(
  realRoot: string,
  expandedTarget: string
): string {
  if (!isTaskWorktreePath(realRoot)) return expandedTarget;
  const leaf = basename(realRoot);
  if (leaf.length === 0) return expandedTarget;
  // Normalize before the prefix check: `./<leaf>/…` and `<root>/./<leaf>/…`
  // are the same echo, and normalization must not become a back door around
  // the leaf strip. Non-matching targets are returned byte-identical.
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
 * `extraWriteRoots` (optional): same semantics for write tools.
 * Write tools (`edit_file` / `write_file`) traditionally do NOT pass extra
 * roots, but the user-profile directory at `~/.iknow/` needs write access so
 * the agent can update `user.md` and `rm BOOTSTRAP.md` directly (replaces the
 * old `/profile done` host hook). A target is allowed if it falls under
 * `root` OR any extra root; symlink-escape is still rejected (realpath runs
 * before this check). Read and write extra roots are passed independently —
 * write tools can use `extraWriteRoots` without exposing any read roots.
 *
 * Extra containment roots plus optional identity pad. Prefer this object
 * over a fifth positional `sessionTmpRoot` so `resolveWithinRoot` stays ≤4
 * parameters. A third-arg array still means `extraReadRoots` (legacy).
 */
export type ResolveWithinRootOptions = {
  readonly extraReadRoots?: readonly string[];
  readonly extraWriteRoots?: readonly string[];
  readonly sessionTmpRoot?: string;
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
  sessionTmpRoot?: string
): Promise<{ absoluteTarget: string; realTmpRoot?: string }> {
  const pad =
    sessionTmpRoot !== undefined && sessionTmpRoot.trim().length > 0
      ? sessionTmpRoot
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
    /** ADR-0092 session tmp pad (after realpath): serves both as an allowed
     *  write root and as the data source for the /tmp rejection message —
     *  one channel, so the same value is not passed twice via extras and a
     *  separate parameter. */
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
  // ADR-0092: a guest Linux `/tmp` is NOT aliased onto the session tmp, so a
  // `/tmp/...` target must fail observably here. But a scratch-path escape is
  // not a delivery escape: the retry guidance points at this identity's
  // expanded `$TMPDIR` absolute pad, not "relative to the taskRoot".
  // EXIT: no pad resolution result (read surface didn't get sessionTmpRoot /
  // legacy call) → fall through to the delivery-escape message below,
  // byte-identical to the pre-split observable behavior.
  if (scratchRel !== undefined && roots.realTmpRoot !== undefined) {
    throw new ToolExecutionError(
      scratchRejectionMessage(prefix, scratchRel, roots.realTmpRoot)
    );
  }
  // EXIT: an escape outside OS /tmp = a delivery escape → keep ADR-0037's
  // taskRoot retry guidance; write root absent → fall back to the base
  // message (no crash, degrades to the base form).
  const deliveryHint =
    realRoot.length > 0
      ? ` (current write root is the live taskRoot: ${realRoot}; scratch files belong in the session tmp dir, $TMPDIR — same lifetime as this identity and not a delivery destination. Retry with a path relative to the taskRoot.)`
      : "";
  throw new ToolExecutionError(`${prefix}${deliveryHint}`);
}

/**
 * Rejection message for a scratch (OS `/tmp`) escape. Only when
 * `<sessionScratch>/X` already exists do we name that canonical host path —
 * still no aliasing: nothing is read, written, or redirected, it is only a
 * wording hint, and the containment decision is unchanged.
 */
function scratchRejectionMessage(
  prefix: string,
  scratchRel: string,
  pad: string
): string {
  const nearMiss = scratchRel.length > 0 ? join(pad, scratchRel) : undefined;
  // EXIT: a failed near-miss existence check (existsSync swallows EACCES /
  // ENOENT etc.) is treated as "does not exist" — never turn a nonexistent
  // path into a "go read this" pointer.
  if (nearMiss !== undefined && existsSync(nearMiss)) {
    return `${prefix} (guest /tmp is not aliased onto this identity's scratch area; ${nearMiss} already exists under the session tmp dir: expanded $TMPDIR is ${pad} — retry with that absolute path there.)`;
  }
  // EXIT: pad present but no near-miss file → give only the expanded $TMPDIR
  // absolute path, implying no specific file exists.
  return `${prefix} (guest /tmp is not aliased onto this identity's scratch area; scratch files belong in the session tmp dir: expanded $TMPDIR is ${pad} — same lifetime as this identity and not a delivery destination.)`;
}

/**
 * Decide whether a rejected target falls under the real OS tmp
 * (`/tmp` or the `tmpdir()` expansion). Used only to branch the rejection
 * wording — never to grant access, or the non-aliased guest `/tmp` would
 * become an attack surface again. Returns the path relative to that tmp
 * root (possibly the empty string when the target is the tmp root itself).
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
    options.sessionTmpRoot
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
