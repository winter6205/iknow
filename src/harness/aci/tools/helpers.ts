import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { ToolExecutionError } from "../../errors.js";

const DEFAULT_KILL_GRACE_MS = 2_000;

export interface SpawnWithStopSignalOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /**
   * Explicit env forwarded to `spawn`. When omitted, child inherits the full
   * process env (used by tests that don't care about isolation). Production
   * callers must pass a pre-filtered env so a leaked host secret can't reach
   * the child via the parent — bwrap's --clearenv covers the in-sandbox half,
   * this covers the outside half (#225).
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam; production callers should use the two-second default. */
  readonly killGraceMs?: number;
}

export interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnWithStopSignalResult {
  readonly child: ChildProcess;
  readonly done: Promise<SpawnResult>;
}

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
 * Write tools (`edit_file` / `write_file`) do NOT pass extraReadRoots, so
 * the write containment stays cwd-scoped.
 */
export async function resolveWithinRoot(
  root: string,
  target: string,
  extraReadRoots?: readonly string[]
): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const expandedTarget = expandHome(target);
  const absoluteTarget = isAbsolute(expandedTarget)
    ? resolve(expandedTarget)
    : resolve(realRoot, expandedTarget);
  const resolvedTarget = await realpathWithMissingSuffix(absoluteTarget);

  const withinPrimary = isWithinRoot(realRoot, resolvedTarget);
  const withinExtras = (extraReadRoots ?? []).some((r) =>
    isWithinRoot(resolve(r), resolvedTarget)
  );
  if (!withinPrimary && !withinExtras) {
    throw new ToolExecutionError(
      `path outside workspace: ${resolvedTarget} not under ${realRoot}`
    );
  }
  return resolvedTarget;
}

/** Truncate by Unicode code points rather than UTF-16 code units. */
export function truncateByCodePoint(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError("max must be a non-negative integer");
  }
  return Array.from(text).slice(0, max).join("");
}

/**
 * Spawn in a detached process group so cancellation can stop the whole tree.
 * The returned promise centralizes output collection and the TERM-to-KILL
 * escalation shared by bash and grep.
 */
export function spawnWithStopSignal(
  command: string,
  args: readonly string[],
  options: SpawnWithStopSignalOptions
): SpawnWithStopSignalResult {
  const child = spawn(command, args, {
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let killTimer: NodeJS.Timeout | undefined;
  let settled = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const stopTree = (): void => {
    const pid = child.pid;
    if (settled || pid === undefined) return;
    killProcessGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      if (!settled) killProcessGroup(pid, "SIGKILL");
    }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    killTimer.unref();
  };

  if (options.signal?.aborted) stopTree();
  else options.signal?.addEventListener("abort", stopTree, { once: true });

  const done = new Promise<SpawnResult>((resolveDone, rejectDone) => {
    child.once("error", (error) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stopTree);
      rejectDone(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stopTree);
      resolveDone({ code, signal, stdout, stderr });
    });
  });

  return { child, done };
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

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
