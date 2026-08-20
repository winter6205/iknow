/**
 * T9a (serve-workspace-folder-browse): default workspace path & eager mkdir.
 *
 * When `iknow serve` starts without `--workspace-root` flag / `IKNOW_WORKSPACE_ROOT`
 * env, the bootstrap auto-binds to `<homedir()>/.iknow/default` so the first
 * new session lands somewhere stable (`workspaceRoot` on `SessionFileV1`,
 * `ws.bound === true` on UI mount). User-preference paths stay explicit
 * (rule 3: explicit bind = explicit trust).
 *
 * resolveSessionDefaultWorkspace() 是 single source of truth — runtime
 * $HOME 解析,让 test fixture (installTestSettingsSource 在 beforeAll 重定
 * HOME) 也能命中 tmp home。早期 export 的 `DEFAULT_SESSION_WORKSPACE` const
 * 在 module load 时锁定 $HOME,无法被 test 改写;review L2 反馈后删除
 * 冗余 const,只留 function。
 */
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default workspace path resolved against current $HOME. Use this when the
 * caller may have redirected HOME (tests via installTestSettingsSource) or
 * when the value needs to track HOME changes across the process lifetime.
 */
export function resolveSessionDefaultWorkspace(): string {
  return join(homedir(), ".iknow", "default");
}

/**
 * Idempotent mkdir for the default workspace. Safe to call repeatedly;
 * `recursive: true` turns EEXIST into a no-op. Eager — call before the hub
 * bind so `hub.bindWorkspace()` can succeed against an existing absolute path.
 */
export async function ensureDefaultWorkspace(): Promise<void> {
  await mkdir(resolveSessionDefaultWorkspace(), { recursive: true });
}
