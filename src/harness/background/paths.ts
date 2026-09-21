/**
 * Background task on-disk path derivation (pure functions, no IO).
 *
 * The registry lives in the **session pool's** project tree (ADR-0088 /
 * ADR-0071):
 * `<poolRoot>/projects/<slug>/tasks/`, same level and same slug as the session
 * folder. `poolRoot` = explicit `--data-dir`, else `~/.iknow` (the ADR-0087
 * `resolveServeDataDir` default).
 * `slug` = `<basename(projectIdentityRoot)>-<sha1(projectIdentityRoot)[:12]>`.
 *
 * Difference vs. the older ADR-0021 workspace-root-anchored shape
 * (`<workspaceRoot>/.iknow/tasks/`) = grouping key: multiple checkouts of the
 * same `projectIdentityRoot` share one live ledger, and a throwaway
 * `--workspace-root` no longer isolates tasks.
 *
 * Pure: no mkdir here; IO belongs to registry / manager (stale-reap tolerates
 * a missing directory).
 */
import { isAbsolute, join } from "node:path";

import { SessionRootError } from "../errors.js";
import { MAX_ROOT_DETAIL_CHARS } from "../session-roots.js";
import {
  computeProjectSlug,
  MAX_PROJECT_IDENTITY_ROOT_BYTES,
} from "../../shared/project-slug.js";
import {
  PROJECTS_DIR_NAME,
  TASKS_DIR_NAME,
} from "../../shared/session-tree-names.js";

/**
 * Task registry root: `<dataDir>/projects/<basename>-<sha1[:12]>/tasks`.
 *
 * Single source of the slug formula and length cap =
 * `src/shared/project-slug.ts` (the same function and constants used by the
 * session folder's `resolveProjectSessionDir`). `src/harness/` is a low-level
 * capability module and must not depend back on `src/session-api/` (Gate B);
 * `src/shared/` is the neutral third layer — one implementation of the
 * formula, drift is impossible.
 *
 * fail-closed semantics match `resolveProjectSessionDir`: missing / blank /
 * relative / over-long `projectIdentityRoot` all throw typed
 * `SessionRootError` (same kind vocabulary as `harness/session-roots.ts`),
 * never silently falling back to `process.cwd()`.
 */
export function resolveTasksDir(opts: {
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
    TASKS_DIR_NAME
  );
}
