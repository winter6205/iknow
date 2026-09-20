/**
 * Default workspace path & eager mkdir.
 *
 * When `iknow serve` starts without `--workspace-root` flag / `IKNOW_WORKSPACE_ROOT`
 * env, the bootstrap auto-binds to `<homedir()>/.iknow/default` so the first
 * new session lands somewhere stable (`workspaceRoot` on `SessionFileV1`,
 * `ws.bound === true` on UI mount). User-preference paths stay explicit
 * (explicit bind = explicit trust).
 *
 * resolveSessionDefaultWorkspace() is the single source of truth —
 * runtime $HOME resolution, so test fixtures that redirect HOME in
 * beforeAll also hit the tmp home. An earlier exported
 * `DEFAULT_SESSION_WORKSPACE` const froze $HOME at module load and
 * could not be overridden by tests; the redundant const was removed,
 * leaving only the function.
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
