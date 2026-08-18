/**
 * #502 T2 — background task 落盘路径派生(纯函数,无 IO)。
 *
 * ADR-0021 D1.3:registry 落在 `<workspaceRoot>/.iknow/tasks/`,workspace-root
 * per-root 命名空间锚(ADR-0019)天然隔开跨 root 的 task。路径形态 mirror
 * src/harness/memory/paths.ts 的 workspace-root 派生先例。纯函数:不做 mkdir,
 * IO 归 registry / manager。
 */
import { join } from "node:path";

/**
 * 任务 registry 根:`<workspaceRoot>/.iknow/tasks`。
 * caller 负责确保 workspaceRoot 存在(CLI 装配期已 initIknowWorkspaceSafe);
 * 本函数只做纯路径拼接。
 */
export function resolveTasksDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".iknow", "tasks");
}
