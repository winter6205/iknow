/**
 * src/harness/aci/tools/enter-worktree.ts
 *
 * The explicit-enter ACI tool of the model-provision contract (ADR-0037
 * amended 2026-08-30, tool-surface extension): when worktree isolation is ON, a session anchored
 * at the MAIN repo can adopt an EXISTING task worktree of THIS repository —
 * including the tree another conversation owns — by passing the owner's
 * conversationId or a unique label returned by list-worktrees. The target
 * path is SSOT-derived (`<repoRoot>/.iknow/worktrees/<leaf>` — a valid
 * kebab-case label IS the leaf, otherwise the conversation id is; see
 * `taskWorktreePath`); the tool NEVER takes a free-form path.
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
 * (`worktree_not_found` / `ambiguous_worktree` / `foreign_worktree` /
 * `rebind_failed` / `git_unavailable`); the tool rethrows as a `ToolExecutionError` carrying
 * `kind=<kind>` — visible, typed, model-actionable, zero tool-side writes.
 *
 * Idempotency: re-entering the same target returns the same path (host
 * no-op) without a second write.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { WorktreeEnterFn } from "../../isolation/worktree-gate.js";
import {
  SAFE_CONVERSATION_ID_RE,
  WorktreeIsolationError,
} from "../../isolation/worktree-gate.js";

export interface WorktreeEnterToolDeps {
  /** Host enter seam (session-api hub, threaded through build-engine). */
  readonly worktreeEnter: WorktreeEnterFn;
  /** This engine's root — the caller's current (main-repo) root. */
  readonly root: string | LiveTaskRoot;
}

/**
 * Factory: createEnterWorktreeTool(deps) — the model-facing explicit
 * enter of the isolation tool face. Registered whenever the host supplies the
 * enter seam (build-engine threading; TUI provision-only wiring, worker
 * assembly paths, and hub-less inlets omit it, so the tool never enters those
 * surfaces). Presence is decoupled from `isolation.worktreeOnMutate` — the
 * switch arms only the mutate gate (ADR-0037 Amendment 2026-09-11 /
 * specs/agent-control-surface.md Slice A).
 */
export function createEnterWorktreeTool(
  deps: WorktreeEnterToolDeps
): AciToolDef {
  return Object.freeze({
    name: "enter-worktree",
    description:
      "Enter an existing git task worktree of this repository, rebind this session's root to it, and return the entered path. " +
      "Pass the owning conversation id or the unique label returned by list-worktrees (for example the tree another " +
      "conversation created); target resolution uses the repository's task-worktree naming SSOT instead of a free-form path. " +
      "On success the session root moves to the entered tree, so re-issue pending workspace writes there in the next wave " +
      "of tool calls in this run. Calling it again for the same target returns the same path. Failures exit typed as " +
      "kind=worktree_not_found | ambiguous_worktree | foreign_worktree | rebind_failed | git_unavailable; resolve the " +
      "reported condition (wrong id, tree in another repository, or leftover state), then retry. " +
      "The entered tree stays untouched, and exit-worktree returns this session to the main repo root.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description:
            "Conversation id or the unique task-worktree label returned by list-worktrees.",
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
      // D2 — `build` (5 min), not `default` (30 s). enter also runs the same
      // bounded project-dep ensure/install path as create, so the same race
      // applies: at `default` the tier timer can fire mid-install and the
      // executor returns a bare `timeout`, silently discarding the install
      // receipt. `build` matches create-worktree (see
      // tests/session-api/worktree-deps.test.ts D2); the install's own
      // `PACKAGE_MANAGER_INSTALL_TIMEOUT_MS` (120 s) is what actually bounds
      // the work, so this raise only guarantees the bound reports first.
      timeoutTier: "build",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const conversationId = ctx?.conversationId;
      const target = (input as { conversationId?: unknown } | null)
        ?.conversationId;
      if (typeof target !== "string" || target.length === 0) {
        throw new ToolExecutionError(
          "[enter-worktree] conversationId is required and must be a non-empty string (the id of the conversation that owns the task worktree)"
        );
      }
      if (!SAFE_CONVERSATION_ID_RE.test(target)) {
        // Same typed-exit label as the WorktreeIsolationError mapping below —
        // the provisioner fails this id with kind=rebind_failed too.
        throw new ToolExecutionError(
          `[enter-worktree] kind=rebind_failed — conversationId ${JSON.stringify(target)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$)`
        );
      }
      try {
        const root =
          typeof deps.root === "string" ? deps.root : deps.root.read();
        const entered = await deps.worktreeEnter({
          conversationId,
          root,
          targetConversationId: target,
        });
        // The receipt is composed by the host seam (session-api): base text
        // plus the constant-on creator disclosure when the tree's owner
        // sidecar yields one (write-situation-disclosure T9 / SC10). The
        // tool emits it verbatim — no second copy of the wording here.
        return entered.receipt;
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[enter-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[enter-worktree] enter failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
