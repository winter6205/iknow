/**
 * src/harness/isolation/worktree-host.ts
 *
 * The **shared assembly SSOT** for the worktree-isolation host `provision`
 * seam (ADR-0037).
 *
 * Background: the seam contract (WorktreeIsolationHostOpts.provision ->
 * WorktreeProvisionContext) is a shared type, but historically every entry
 * point hand-wrote an inline wrapper — manual field-by-field destructuring
 * silently drops new WorktreeProvisionContext fields while still compiling.
 * This pattern bit twice as real bugs: an inline cli.ts destructure that
 * dropped `name` (CLI degraded to UUID-only leaves) and the same in
 * tui/run.tsx (valid model-provided labels still built UUID trees).
 *
 * Rule: any entry point (cli / tui / serve / hub / future additions) MUST
 * assemble the provision seam through this factory — no hand-written
 * field-by-field wrappers. The factory passes the whole ctx through
 * untouched, so future WorktreeProvisionContext fields need zero changes
 * here.
 */
import type {
  WorktreeProvisionContext,
  WorktreeProvisionFn,
} from "./worktree-gate.js";

/** Shared provision-seam assembly dependency: the hub-side implementation is injected by the entry point. */
export interface WorktreeHostProvisionOpts {
  /**
   * Hub-side provision implementation — receives the **complete**
   * WorktreeProvisionContext (including `name`). A synchronous throw =
   * fail-closed (e.g. hub not ready).
   */
  readonly provisionWorktree: (
    ctx: WorktreeProvisionContext
  ) => Promise<string>;
}

/**
 * Assemble the worktree-isolation host's `provision` field (whole ctx
 * passed through untouched). The return value fills
 * `WorktreeIsolationHostOpts.provision` directly.
 */
export function createWorktreeHostProvision(opts: WorktreeHostProvisionOpts): {
  provision: WorktreeProvisionFn;
} {
  const { provisionWorktree } = opts;
  return {
    provision: (ctx) => provisionWorktree(ctx),
  };
}
