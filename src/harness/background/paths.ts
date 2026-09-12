/**
 * #502 T2 — background task 落盘路径派生(纯函数,无 IO)。
 *
 * ADR-0088(home 项目树)/ ADR-0071:registry 落在**会话池**的项目树里 ——
 * `<poolRoot>/projects/<slug>/tasks/`,与会话文件夹同层同 slug。`poolRoot` =
 * 显式 `--data-dir` 否则 `~/.iknow`(ADR-0087 `resolveServeDataDir` 的默认),
 * `slug` = `<basename(projectIdentityRoot)>-<sha1(projectIdentityRoot)[:12]>`。
 *
 * 与 ADR-0021 D1.3 的旧形态(`<workspaceRoot>/.iknow/tasks/`,workspace-root
 * per-root 命名空间锚)的差别 = 分组键:同一 `projectIdentityRoot` 的多份
 * checkout 共用一份活账本,throwaway `--workspace-root` 不再隔离 tasks。
 *
 * 纯函数:不做 mkdir,IO 归 registry / manager(stale-reap 对缺失目录容忍)。
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
 * 任务 registry 根:`<dataDir>/projects/<basename>-<sha1[:12]>/tasks`。
 *
 * slug 公式与长度上限的唯一来源 = `src/shared/project-slug.ts`(与会话文件夹
 * 的 `resolveProjectSessionDir` 同一函数、同一常量)。`src/harness/` 是底层
 * 能力模块,不可反向依赖 `src/session-api/`(Gate B),`src/shared/` 是三方
 * 中立层 —— 公式只此一份实现,漂移不再可能。
 *
 * fail-closed 语义同 `resolveProjectSessionDir`:缺根 / 空白 / 相对 /
 * 超长 `projectIdentityRoot` 一律抛 typed `SessionRootError`(与
 * `harness/session-roots.ts` 同一 kind 词汇表),不静默回退 `process.cwd()`。
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
