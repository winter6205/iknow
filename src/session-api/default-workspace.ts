/**
 * T9a (serve-workspace-folder-browse): default workspace path & eager mkdir.
 *
 * When `iknow serve` starts without `--workspace-root` flag / `IKNOW_WORKSPACE_ROOT`
 * env, the bootstrap auto-binds to `<homedir()>/.iknow/default` so the first
 * new session lands somewhere stable (`workspaceRoot` on `SessionFileV1`,
 * `ws.bound === true` on UI mount). User-preference paths stay explicit
 * (rule 3: explicit bind = explicit trust).
 *
 * Two flavors exported:
 *  - `DEFAULT_SESSION_WORKSPACE` — pure constant resolved at module load.
 *    Use in production where HOME is stable across the process lifetime.
 *  - `getDefaultSessionWorkspace()` — function that re-reads $HOME at call
 *    time. Required by `ensureDefaultWorkspace()` so test HOME overrides
 *    (installTestSettingsSource redirects HOME in beforeAll, AFTER this
 *    module may already be imported) land in the tmp home, not the user's
 *    real $HOME.
 */
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Fixed default workspace path when user did not pick one. */
export const DEFAULT_SESSION_WORKSPACE = join(homedir(), ".iknow", "default");

/**
 * Default workspace path resolved against current $HOME. Use this when the
 * caller may have redirected HOME (tests via installTestSettingsSource) or
 * when the value needs to track HOME changes across the process lifetime.
 */
export function getDefaultSessionWorkspace(): string {
  return join(homedir(), ".iknow", "default");
}

/**
 * Idempotent mkdir for the default workspace. Safe to call repeatedly;
 * `recursive: true` turns EEXIST into a no-op. Eager — call before the hub
 * bind so `hub.bindWorkspace()` can succeed against an existing absolute path.
 */
export async function ensureDefaultWorkspace(): Promise<void> {
  await mkdir(getDefaultSessionWorkspace(), { recursive: true });
}
