/**
 * MCP dual-root resolver — the single point where MCP roots are derived.
 *
 * Across a session worktree rebind, the stdio child cwd / tool FS root and the
 * config root all come from here; callers (config / manager / build-engine / hub /
 * CLI / TUI) only consume the returned values — never compose paths themselves,
 * read `process.cwd()`, or detect task worktrees.
 *
 *  - `workspaceRoot`: the current session/task root — cwd for stdio children and
 *    the tool FS root; after rebind it points to
 *    `<productRoot>/.iknow/worktrees/<conversationId>`.
 *  - `mcpConfigRoot`: derives ONLY from the stable `productRoot` (the main checkout
 *    captured at first assembly) and never changes across rebinds; project-level
 *    config is read from `<mcpConfigRoot>/.iknow/mcp.json`.
 *
 * Pure function: no git, no filesystem, no session state. Missing roots / blank /
 * relative / non-normalizable values / mismatch with an established root all fail
 * closed by throwing `McpLifecycleError` (kinds in `src/harness/errors.ts`);
 * never fall back to `process.cwd()`.
 */
import path from "node:path";

import { McpLifecycleError } from "../errors.js";
import type { McpLifecycleErrorKind } from "../errors.js";

/** Cap for root values echoed in diagnostics: keep messages bounded even for long paths. */
const MAX_ROOT_DETAIL_CHARS = 120;

/** The resolver's only output: two normalized absolute roots. */
export interface McpRoots {
  readonly workspaceRoot: string;
  readonly mcpConfigRoot: string;
}

export interface ResolveMcpRootsInput {
  /** Current session/task root (a task worktree after rebind). */
  readonly workspaceRoot: string | undefined;
  /** Stable main checkout captured at first assembly; the only source of `mcpConfigRoot`. */
  readonly productRoot: string | undefined;
  /**
   * An already-pinned root (explicit sandbox / ACI FS root, or the active manager's
   * cwd on reload). When present it joins validation: different from the resolved
   * `workspaceRoot` → `root_mismatch`.
   */
  readonly expectedWorkspaceRoot?: string | undefined;
}

/**
 * Resolve the dual roots. Every validation failure throws before any config read,
 * process spawn, or tool execution.
 *
 * Kind assignment:
 *  - root absent (not provided / non-string) → `missing_cwd`
 *  - `workspaceRoot` (incl. `expectedWorkspaceRoot`) blank / relative / non-normalizable → `invalid_cwd`
 *  - `productRoot` blank / relative / non-normalizable → `invalid_config_root`
 *  - `expectedWorkspaceRoot` differs from the resolved value → `root_mismatch`
 */
export function resolveMcpRoots(input: ResolveMcpRootsInput): McpRoots {
  const workspaceRoot = normalizeRoot(
    input.workspaceRoot,
    "workspaceRoot",
    "invalid_cwd"
  );
  const mcpConfigRoot = normalizeRoot(
    input.productRoot,
    "productRoot",
    "invalid_config_root"
  );

  if (input.expectedWorkspaceRoot !== undefined) {
    const expected = normalizeRoot(
      input.expectedWorkspaceRoot,
      "expectedWorkspaceRoot",
      "invalid_cwd"
    );
    if (expected !== workspaceRoot) {
      const half = MAX_ROOT_DETAIL_CHARS / 2;
      throw new McpLifecycleError(
        "root_mismatch",
        `expected workspace root ${quoteRoot(expected, half)} does not match resolved workspace root ${quoteRoot(workspaceRoot, half)}`
      );
    }
  }

  return { workspaceRoot, mcpConfigRoot };
}

/** Absent → `missing_cwd`; present but unusable → the invalid kind chosen by the caller. */
function normalizeRoot(
  value: string | undefined,
  label: string,
  invalidKind: McpLifecycleErrorKind
): string {
  if (typeof value !== "string") {
    throw new McpLifecycleError(
      "missing_cwd",
      `${label} is required and was not provided`
    );
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new McpLifecycleError(
      invalidKind,
      `${label} must be a normalizable absolute path, got ${quoteRoot(trimmed, MAX_ROOT_DETAIL_CHARS)}`
    );
  }

  const normalized = stripTrailingSeparators(path.normalize(trimmed));
  if (!path.isAbsolute(normalized)) {
    throw new McpLifecycleError(
      invalidKind,
      `${label} must be an absolute path, got ${quoteRoot(trimmed, MAX_ROOT_DETAIL_CHARS)}`
    );
  }
  return normalized;
}

/** Strip trailing separators, but keep the filesystem root itself (posix `/`, win32 `C:\`). */
function stripTrailingSeparators(p: string): string {
  const { root } = path.parse(p);
  let out = p;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Diagnostic echo: truncate to a bounded length so huge paths cannot blow up error messages. */
function quoteRoot(value: string, limit: number): string {
  const shown = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return `'${shown}'`;
}
