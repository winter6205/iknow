/**
 * src/harness/aci/tools/create-task-worktree.ts
 *
 * T4 (plans/worktree-isolation-model-provision.md) — the 创建工作树 ACI tool
 * of the model-provision contract (ADR-0037 amended 2026-08-30): when
 * worktree isolation is ON and a workspace mutate was blocked by the
 * `[worktree_isolation]` gate, the model calls THIS tool to create the
 * conversation's task worktree and rebind the session root to it. Tool
 * success = the tree exists at `<repoRoot>/.iknow/worktrees/<conversationId>`
 * AND the session root has moved there.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - the tool owns NOTHING but the model-facing shape: it takes no
 *     parameters, reads `conversationId` from ToolExecutionContext, and
 *     delegates every side effect (git worktree add, rebind, dirty-root
 *     persistence) to the host provision seam (`WorktreeProvisionContext`
 *     shape, injected by build-engine from the session-api hub). No
 *     session-api imports; the naming/git SSOT stays in
 *     `harness/isolation/worktree-gate.ts`.
 *   - the tool name is byte-identical to T3's
 *     `CREATE_TASK_WORKTREE_TOOL_HINT` ("create-task-worktree ACI tool") so
 *     the gate block message points at a tool that exists by that name.
 *
 * Failure semantics (hard req 5–6): the host seam fails closed with a typed
 * `WorktreeIsolationError` (branch_exists / worktree_exists /
 * worktree_add_failed / rebind_failed / foreign_worktree / not_a_git_repo /
 * git_unavailable); the tool rethrows it as a `ToolExecutionError` carrying
 * `kind=<kind>` — visible, typed, model-actionable, and with zero tool-side
 * writes (the seam itself guarantees main-repo zero-write on failure).
 *
 * Idempotency (hard req 7): the same conversation may call the tool again —
 * the host provision seam is idempotent (own tree → same-root no-op), so a
 * repeat call returns the same root without a second `git worktree add`.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type { WorktreeProvisionFn } from "../../isolation/worktree-gate.js";
import { WorktreeIsolationError } from "../../isolation/worktree-gate.js";

/**
 * Back-compat alias for the gate's `WorktreeProvisionFn` SSOT (registry.ts
 * imports this name); the definition lives in worktree-gate.ts only.
 */
export type { WorktreeProvisionFn as CreateTaskWorktreeProvisionFn };

export interface CreateTaskWorktreeToolDeps {
  /** Host provision seam (session-api hub, threaded through build-engine). */
  readonly provision: WorktreeProvisionFn;
  /** This engine's root — the session's current root at assembly time. */
  readonly root: string;
}

/**
 * Factory: createCreateTaskWorktreeTool(deps) — the model-facing escape hatch
 * of the isolation gate. Registered ONLY when the isolation switch is ON and
 * the host supplies the provision seam (build-engine threading; worker
 * assembly paths omit it, so the tool never enters a worker tool surface).
 */
export function createCreateTaskWorktreeTool(
  deps: CreateTaskWorktreeToolDeps
): AciToolDef {
  return Object.freeze({
    name: "create-task-worktree",
    description:
      "Create this conversation's isolated git task worktree and rebind the session root to it. " +
      "Use it when worktree isolation is ON and a workspace mutation came back blocked with the " +
      "[worktree_isolation] notice. Takes no parameters. On success the tree exists at " +
      "<repoRoot>/.iknow/worktrees/<conversationId> on branch iknow/task-<conversationId> and the " +
      "session root has moved there; re-issue the blocked write in the new root on your next turn. " +
      "Calling it again for the same conversation is idempotent (returns the same root). " +
      "Failures exit typed as kind=branch_exists | worktree_exists | worktree_add_failed | " +
      "rebind_failed | foreign_worktree | not_a_git_repo | git_unavailable; resolve the reported " +
      "leftover tree or branch manually, then retry.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (_input: unknown, ctx?: ToolExecutionContext) => {
      const conversationId = ctx?.conversationId;
      try {
        const worktreePath = await deps.provision({
          conversationId,
          root: deps.root,
        });
        return (
          `task worktree ready: ${worktreePath} (session root rebound; ` +
          `re-issue the blocked write in the new root on your next turn)`
        );
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[create-task-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[create-task-worktree] provision failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
