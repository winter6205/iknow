/**
 * src/harness/aci/tools/exit-task-worktree.ts
 *
 * T8 (plans/worktree-isolation-model-provision.md) — the symmetric-exit ACI
 * tool of the model-provision contract (ADR-0037 amended 2026-08-30, T8
 * tool-surface extension): a session currently rebound to a task worktree
 * returns to its MAIN repo root. Takes no parameters — the tree is the
 * engine root, and the main repo root is derived from the tree itself by
 * the host seam (git common dir; restart-safe). The task worktree is
 * PRESERVED (orphan cleanup is an explicit non-goal of the plan); re-enter
 * it later with the enter-task-worktree tool.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - the tool owns NOTHING but the model-facing shape: it takes no input,
 *     reads `conversationId` from ToolExecutionContext, and delegates every
 *     side effect (rebound detection, repo-root derivation, rebind
 *     persistence) to the host exit seam (`WorktreeExitContext` shape,
 *     injected by build-engine from the session-api hub). No session-api
 *     imports; no git/fs access here.
 *
 * Failure semantics (fail-closed, hard req 6): a session that is not
 * currently rebound (no bound entry, no durable workspaceRoot anchor, no
 * task-worktree-shaped current root) exits typed
 * `kind=rebind_failed`; the tool rethrows host `WorktreeIsolationError`s as
 * `ToolExecutionError` carrying `kind=<kind>` — visible, typed,
 * model-actionable, zero tool-side writes.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type { WorktreeExitFn } from "../../isolation/worktree-gate.js";
import { WorktreeIsolationError } from "../../isolation/worktree-gate.js";

export interface WorktreeExitToolDeps {
  /** Host exit seam (session-api hub, threaded through build-engine). */
  readonly worktreeExit: WorktreeExitFn;
  /** This engine's root — the task worktree the session is currently on. */
  readonly root: string;
}

/**
 * Factory: createExitTaskWorktreeTool(deps) — the model-facing symmetric
 * exit of the isolation tool face. Registered ONLY when the isolation
 * switch is ON and the host supplies the exit seam (build-engine threading;
 * TUI provision-only wiring, worker assembly paths, and hub-less inlets
 * omit it, so the tool never enters those surfaces).
 */
export function createExitTaskWorktreeTool(
  deps: WorktreeExitToolDeps
): AciToolDef {
  return Object.freeze({
    name: "exit-task-worktree",
    description:
      "Return this session's root to the main repository checkout from the task worktree it is currently bound to. " +
      "Use it when the isolated task is finished and subsequent workspace writes should land in the main repo again. " +
      "Takes no parameters. On success the session root returns to the main repo root and pending writes can be " +
      "re-issued there on your next turn; the task worktree itself is preserved (work in it again later with the " +
      "enter-task-worktree tool). Failures exit typed as kind=rebind_failed | git_unavailable — for example when " +
      "this session is not currently bound to a task worktree. Calling it while already on the main repo root " +
      "returns the typed rebind_failed kind instead of a silent no-op.",
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
        const repoRoot = await deps.worktreeExit({
          conversationId,
          root: deps.root,
        });
        return (
          `session root returned to main repo: ${repoRoot} (the task worktree ` +
          `${deps.root} is preserved; re-issue pending writes in the main repo ` +
          `on your next turn)`
        );
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[exit-task-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[exit-task-worktree] exit failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
