/**
 * TUI-entry worktree isolation host wiring (ADR-0037). The `provision`
 * pass-through body lives in the shared SSOT
 * `harness/isolation/worktree-host.ts` — inlining a manual destructure here
 * once dropped `name`, hence the single forwarding path. The remaining seams
 * (enter / exit / list / remove) forward the WHOLE context untouched, for the
 * same reason: a field-by-field wrapper silently drops new context fields
 * while still compiling. Seam-presence decides ACI registry membership
 * (`WorktreeIsolationHostOpts` doc, Gate 3 mirror filter): an omitted seam
 * leaves its tool out. This file keeps only the TUI-side dependency shape
 * (late-bound hub bridgeRef). Fail-closed when the hub is absent is run.tsx
 * bridge logic (only it knows bridgeRef) and stays out of this shell.
 */
import type {
  WorktreeEnterFn,
  WorktreeExitFn,
  WorktreeIsolationHostOpts,
  WorktreeListFn,
  WorktreeProvisionFn,
  WorktreeRemoveFn,
} from "../harness/isolation/worktree-gate.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";

/** TUI host wiring deps: hub-side implementations are injected by the caller (run.tsx). */
export interface TuiWorktreeHostFactoryOpts {
  /** Hub-side provision seam; the factory reads it only at call time (bridgeRef is late-bound). */
  readonly provisionWorktree: WorktreeProvisionFn;
  /** Hub-side explicit-enter seam (absent → `enter-worktree` stays out of the registry). */
  readonly enterWorktree?: WorktreeEnterFn;
  /** Hub-side symmetric-exit seam (absent → `exit-worktree` stays out of the registry). */
  readonly exitWorktree?: WorktreeExitFn;
  /** Hub-side read-only listing seam (absent → `list-worktrees` stays out of the registry). */
  readonly listTaskWorktrees?: WorktreeListFn;
  /** Hub-side removal seam (absent → `remove-worktree` stays out of the registry). */
  readonly removeTaskWorktree?: WorktreeRemoveFn;
}

/**
 * Build the worktree isolation host opts for the TUI entry. `provision` goes
 * through the shared SSOT factory; the rest are whole-context pass-throughs.
 * Each omitted seam is left out of the returned object so the matching ACI
 * tool is excluded, mirroring the host's own doc contract.
 */
export function createTuiWorktreeIsolationHost(
  opts: TuiWorktreeHostFactoryOpts
): WorktreeIsolationHostOpts {
  const {
    provisionWorktree,
    enterWorktree,
    exitWorktree,
    listTaskWorktrees,
    removeTaskWorktree,
  } = opts;
  return {
    // Pure pass-through via the shared SSOT; keep field forwarding intact so `name` is never dropped.
    ...createWorktreeHostProvision({ provisionWorktree }),
    ...(enterWorktree ? { worktreeEnter: (ctx) => enterWorktree(ctx) } : {}),
    ...(exitWorktree ? { worktreeExit: (ctx) => exitWorktree(ctx) } : {}),
    ...(listTaskWorktrees
      ? { worktreeList: (ctx) => listTaskWorktrees(ctx) }
      : {}),
    ...(removeTaskWorktree
      ? { worktreeRemove: (ctx) => removeTaskWorktree(ctx) }
      : {}),
  };
}
