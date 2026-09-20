/**
 * CLI entry seam that assembles the worktree isolation host (ADR-0037).
 * The pass-through body lives in the shared SSOT
 * `harness/isolation/worktree-host.ts` — after entry-level manual
 * destructuring dropped `name` twice, all forwarding converged there. This
 * file keeps only the CLI-side dependency shape (injected provisioner) and
 * the existing exports; cli.ts main() still assembles from here.
 */
import type { WorktreeIsolationHostOpts } from "../harness/isolation/worktree-gate.js";
import type { TaskWorktreeProvisioner } from "../session-api/worktree-rebind.js";
import { createWorktreeHostProvision } from "../harness/isolation/worktree-host.js";

/** CLI host seam dependency: provisioner is constructed and injected by the caller (cli.ts main). */
export interface WorktreeHostFactoryOpts {
  readonly worktreeProvisioner: TaskWorktreeProvisioner;
}

/** Assemble worktree isolation host opts for the CLI entry (provision is a pure pass-through). */
export function createWorktreeIsolationHost(
  opts: WorktreeHostFactoryOpts
): WorktreeIsolationHostOpts {
  const { worktreeProvisioner } = opts;
  // Pure pass-through via the shared SSOT; entry-level manual destructuring is banned.
  return createWorktreeHostProvision({
    provisionWorktree: (ctx) => worktreeProvisioner.provision(ctx),
  });
}
