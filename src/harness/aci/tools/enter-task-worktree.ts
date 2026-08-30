/**
 * src/harness/aci/tools/enter-task-worktree.ts
 *
 * T7 (plans/worktree-isolation-model-provision.md) — the explicit-enter ACI
 * tool of the model-provision contract (ADR-0037 amended 2026-08-30, T7
 * tool-surface extension): when worktree isolation is ON, a session anchored
 * at the MAIN repo can adopt an EXISTING task worktree of THIS repository —
 * including the tree another conversation owns — by passing the owner's
 * conversationId. The target path is SSOT-derived
 * (`<repoRoot>/.iknow/worktrees/<conversationId>`); the tool NEVER takes a
 * free-form path.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - the tool owns NOTHING but the model-facing shape: input validation
 *     (conversationId is a safe path/branch segment, SSOT regex in
 *     worktree-gate.ts) and delegation. Every side effect (tree validation,
 *     rebind, dirty-root persistence) goes to the host enter seam
 *     (`WorktreeEnterContext` shape, injected by build-engine from the
 *     session-api hub). No session-api imports; no git/fs access here.
 *
 * Authorization semantics: the durable rebind record (persisted
 * session.workspaceRoot) is what later admits the session's mutates on the
 * entered tree's engine — including another conversation's tree. The gate
 * itself is unchanged; the provision adjudication adopts the persisted
 * anchor (worktree-rebind.ts T7 branch).
 *
 * Failure semantics (fail-closed, hard req 6): the host seam exits typed
 * (`worktree_not_found` / `foreign_worktree` / `rebind_failed` /
 * `git_unavailable`); the tool rethrows as a `ToolExecutionError` carrying
 * `kind=<kind>` — visible, typed, model-actionable, zero tool-side writes.
 *
 * Idempotency: re-entering the same target returns the same path (host
 * no-op) without a second write.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type { WorktreeEnterFn } from "../../isolation/worktree-gate.js";
import {
  SAFE_CONVERSATION_ID_RE,
  WorktreeIsolationError,
} from "../../isolation/worktree-gate.js";

export interface WorktreeEnterToolDeps {
  /** Host enter seam (session-api hub, threaded through build-engine). */
  readonly worktreeEnter: WorktreeEnterFn;
  /** This engine's root — the caller's current (main-repo) root. */
  readonly root: string;
}

/**
 * Factory: createEnterTaskWorktreeTool(deps) — the model-facing explicit
 * enter of the isolation tool face. Registered ONLY when the isolation
 * switch is ON and the host supplies the enter seam (build-engine threading;
 * TUI provision-only wiring, worker assembly paths, and hub-less inlets omit
 * it, so the tool never enters those surfaces).
 */
export function createEnterTaskWorktreeTool(
  deps: WorktreeEnterToolDeps
): AciToolDef {
  return Object.freeze({
    name: "enter-task-worktree",
    description:
      "Enter an existing git task worktree of this repository and rebind this session's root to it. " +
      "Use it when worktree isolation is ON and the work you need continues in a task worktree that already " +
      "exists — for example the tree another conversation created: pass that conversation's id as " +
      "conversationId and the target resolves to <repoRoot>/.iknow/worktrees/<conversationId>. " +
      "On success the session root moves to the entered tree; re-issue pending workspace writes there on " +
      "your next turn. Calling it again for the same target returns the same path (idempotent). " +
      "Failures exit typed as kind=worktree_not_found | foreign_worktree | rebind_failed | git_unavailable; " +
      "resolve the reported condition (wrong id, tree in another repository, or leftover state), then retry. " +
      "The entered tree stays untouched; exit-task-worktree returns this session to the main repo root.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description:
            "Conversation id that owns the task worktree to enter (the tree lives at " +
            "<repoRoot>/.iknow/worktrees/<conversationId>).",
          minLength: 1,
        },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const conversationId = ctx?.conversationId;
      const target = (input as { conversationId?: unknown } | null)
        ?.conversationId;
      if (typeof target !== "string" || target.length === 0) {
        throw new ToolExecutionError(
          "[enter-task-worktree] conversationId is required and must be a non-empty string (the id of the conversation that owns the task worktree)"
        );
      }
      if (!SAFE_CONVERSATION_ID_RE.test(target)) {
        // Same typed-exit label as the WorktreeIsolationError mapping below —
        // the provisioner fails this id with kind=rebind_failed too.
        throw new ToolExecutionError(
          `[enter-task-worktree] kind=rebind_failed — conversationId ${JSON.stringify(target)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$)`
        );
      }
      try {
        const worktreePath = await deps.worktreeEnter({
          conversationId,
          root: deps.root,
          targetConversationId: target,
        });
        return (
          `entered task worktree: ${worktreePath} (session root rebound; ` +
          `re-issue pending writes in the entered tree on your next turn)`
        );
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[enter-task-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[enter-task-worktree] enter failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
