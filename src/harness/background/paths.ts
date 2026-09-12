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
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";

import { SessionRootError } from "../errors.js";
import {
  PROJECTS_DIR_NAME,
  TASKS_DIR_NAME,
} from "../../shared/session-tree-names.js";

/**
 * 任务 registry 根:`<dataDir>/projects/<basename>-<sha1[:12]>/tasks`。
 *
 * slug 公式**刻意内联**而不从 `src/session-api/store/session-store.ts` 的
 * `resolveProjectSessionDir` 导入:`src/harness/` 是底层能力模块,不可反向
 * 依赖 `src/session-api/`(Gate B,同 `harness/skill/body.ts` 对
 * `MAX_MESSAGE_CHARS` 的处理)。两处必须**逐字节一致** —— 任务登记与会话
 * 文件夹挂在同一个 `<slug>` 下,漂移会把账本分到孤儿目录。改任一处必须
 * 同步另一处(消费方测试用 `createHash` 现算摘要,不写死字面量)。
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
  if (trimmed === "" || trimmed.length > MAX_ROOT_DETAIL_CHARS) {
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
  const digest = createHash("sha1").update(trimmed).digest("hex").slice(0, 12);
  return join(
    opts.dataDir,
    PROJECTS_DIR_NAME,
    `${basename(trimmed)}-${digest}`,
    TASKS_DIR_NAME
  );
}

/**
 * `path.isAbsolute` 的等价判定 —— 见 `session-store.ts` 的同一常量用法:
 * 上限与 `SessionRootError` 诊断回显口径对齐。
 */
const MAX_ROOT_DETAIL_CHARS = 120;
