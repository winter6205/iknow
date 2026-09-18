/**
 * 项目记忆库路径派生（纯函数，无 IO）。
 *
 * ADR-0099 / ADR-0088:项目记忆落在 **home 项目树** 兄弟目录 ——
 * `<poolRoot>/projects/<slug>/memory/`，与会话文件夹、`tasks/` 同 slug。
 * `poolRoot` = 显式 `--data-dir` 否则 `~/.iknow`；slug =
 * `<basename(projectIdentityRoot)>-<sha1(projectIdentityRoot)[:12]>`。
 *
 * 与 ADR-0019 T2 的旧形态（`<workspaceRoot>/.iknow/memory/<slug>`）差别 =
 * 分组键:同一 `projectIdentityRoot` 的多份 checkout 共用一份记忆库，
 * throwaway `--workspace-root` 不再隔离项目记忆。
 *
 * `resolveUserMemoryDir` 仍是 per-root 用户层父目录（说明书装配不走本路径）。
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
 * 项目记忆库根:`<dataDir>/projects/<basename>-<sha1[:12]>/memory`。
 *
 * fail-closed 语义同 `resolveTasksDir`:缺根 / 空白 / 相对 / 超长
 * `projectIdentityRoot` 一律抛 typed `SessionRootError`。
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
