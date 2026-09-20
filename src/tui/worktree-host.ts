/**
 * TUI-entry worktree isolation host wiring (ADR-0037). The pass-through
 * body lives in the shared SSOT `harness/isolation/worktree-host.ts` —
 * inlining a manual destructure here once dropped `name`, hence the
 * single forwarding path. This file keeps only the TUI-side dependency
 * shape (late-bound hub bridgeRef). Fail-closed when the hub is absent
 * is run.tsx bridge logic (only it knows bridgeRef) and stays out of
 * this shell.
 */
import type { WorktreeProvisionFn } from "../harness/isolation/worktree-gate.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";

/** TUI host wiring deps: hub-side implementation is injected by the caller (run.tsx). */
export interface TuiWorktreeHostFactoryOpts {
  /** Hub-side provision seam; the factory reads it only at call time (bridgeRef is late-bound). */
  readonly provisionWorktree: WorktreeProvisionFn;
}

/** Build the worktree isolation host opts for the TUI entry (provision is a pure pass-through). */
export function createTuiWorktreeIsolationHost(
  opts: TuiWorktreeHostFactoryOpts
): {
  provision: WorktreeProvisionFn;
} {
  // Pure pass-through via the shared SSOT; keep field forwarding intact so `name` is never dropped.
  return createWorktreeHostProvision({
    provisionWorktree: opts.provisionWorktree,
  });
}
