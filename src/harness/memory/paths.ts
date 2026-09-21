/**
 * Project memory-store path derivation (pure functions, no IO).
 *
 * Project memory lives in the **home project tree** as a sibling directory
 * (ADR-0099 / ADR-0088): `<poolRoot>/projects/<slug>/memory/`, same slug as the session
 * folder and `tasks/`. `poolRoot` = explicit `--data-dir`, else `~/.iknow`;
 * slug = `<basename(projectIdentityRoot)>-<sha1(projectIdentityRoot)[:12]>`.
 *
 * Difference vs. the older workspace-root-anchored shape (ADR-0019)
 * (`<workspaceRoot>/.iknow/memory/<slug>`) = grouping key: multiple checkouts
 * of the same `projectIdentityRoot` share one memory store, and a throwaway
 * `--workspace-root` no longer isolates project memory.
 *
 * `resolveUserMemoryDir` remains the per-root user-layer parent (manual-style
 * assembly does not go through this path).
 */
import { isAbsolute, join } from "node:path";

import { SessionRootError } from "../errors.js";
import { MAX_ROOT_DETAIL_CHARS } from "../session-roots.js";
import {
  computeProjectSlug,
  MAX_PROJECT_IDENTITY_ROOT_BYTES,
} from "../../shared/project-slug.js";
import {
  MEMORY_DIR_NAME,
  PROJECTS_DIR_NAME,
} from "../../shared/session-tree-names.js";
import { resolveWorkspaceRoot } from "../../config/workspace-root.js";

/**
 * Project memory-store root: `<dataDir>/projects/<basename>-<sha1[:12]>/memory`.
 *
 * fail-closed semantics match `resolveTasksDir`: missing / blank / relative /
 * over-long `projectIdentityRoot` all throw a typed `SessionRootError`.
 */
export function resolveProjectMemoryDir(opts: {
  readonly dataDir: string;
  readonly projectIdentityRoot: string;
}): string {
  const root = opts.projectIdentityRoot;
  if (typeof root !== "string") {
    throw new SessionRootError(
      "missing_root",
      "projectIdentityRoot is required and was not provided"
    );
  }
  const trimmed = root.trim();
  if (trimmed === "" || trimmed.length > MAX_PROJECT_IDENTITY_ROOT_BYTES) {
    throw new SessionRootError(
      "missing_root",
      "projectIdentityRoot is required and must be non-empty"
    );
  }
  if (!isAbsolute(trimmed)) {
    throw new SessionRootError(
      "invalid_root",
      `projectIdentityRoot must be an absolute path, got '${trimmed.slice(0, MAX_ROOT_DETAIL_CHARS)}'`
    );
  }
  return join(
    opts.dataDir,
    PROJECTS_DIR_NAME,
    computeProjectSlug(trimmed),
    MEMORY_DIR_NAME
  );
}

/**
 * Per-root user-level memory parent (`<workspaceRoot>/.iknow/memory`).
 * Independent of cwd and --data-dir. Not the project store (ADR-0099).
 */
export function resolveUserMemoryDir(
  workspaceRoot?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const root = workspaceRoot ?? resolveWorkspaceRoot({ env });
  return join(root, ".iknow", "memory");
}
