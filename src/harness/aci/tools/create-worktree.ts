/**
 * src/harness/aci/tools/create-worktree.ts
 *
 * The create-worktree ACI tool of the model-provision contract (ADR-0037):
 * when worktree isolation is ON and a workspace mutate was blocked by the
 * `[worktree_isolation]` gate, the model calls THIS tool to create the
 * conversation's task worktree and rebind the session root to it. Tool
 * success = the tree exists at `<repoRoot>/.iknow/worktrees/<leaf>` (a valid
 * kebab-case label IS the leaf; without one the conversation id is the leaf)
 * AND the session root has moved there.
 *
 * Module boundary (bounded-context guard):
 *   - the tool owns NOTHING but the model-facing shape: it takes no
 *     parameters, reads `conversationId` from ToolExecutionContext, and
 *     delegates every side effect (git worktree add, rebind, dirty-root
 *     persistence) to the host provision seam (`WorktreeProvisionContext`
 *     shape, injected by build-engine from the session-api hub). No
 *     session-api imports; the naming/git SSOT stays in
 *     `harness/isolation/worktree-gate.ts`.
 *   - the tool name is byte-identical to the gate's
 *     `CREATE_WORKTREE_TOOL_HINT` ("create-worktree ACI tool") so
 *     the gate block message points at a tool that exists by that name.
 *
 * Failure semantics: the host seam fails closed with a typed
 * `WorktreeIsolationError` (branch_exists / worktree_exists /
 * worktree_add_failed / rebind_failed / foreign_worktree / not_a_git_repo /
 * git_unavailable); the tool rethrows it as a `ToolExecutionError` carrying
 * `kind=<kind>` — visible, typed, model-actionable, and with zero tool-side
 * writes (the seam itself guarantees main-repo zero-write on failure).
 *
 * Idempotency: the same conversation may call the tool again —
 * the host provision seam is idempotent (own tree → same-root no-op), so a
 * repeat call returns the same root without a second `git worktree add`.
 *
 * The host also installs the new tree's PROJECT deps (lockfile-driven,
 * fail-open, never a global CLI, never a whole-tree `node_modules` symlink).
 * The outcome is reported through the provision context's optional `report`
 * callback, so the tool result carries linked/skipped/failed alongside the
 * tree path.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import type { WorktreeProvisionFn } from "../../isolation/worktree-gate.js";
import {
  resolveTaskWorktreeLabel,
  WorktreeIsolationError,
} from "../../isolation/worktree-gate.js";

/**
 * Back-compat alias for the gate's `WorktreeProvisionFn` SSOT (registry.ts
 * imports this name); the definition lives in worktree-gate.ts only.
 */
export type { WorktreeProvisionFn as CreateWorktreeProvisionFn };

export interface CreateWorktreeToolDeps {
  /** Host provision seam (session-api hub, threaded through build-engine). */
  readonly provision: WorktreeProvisionFn;
  /** This engine's root — the session's current root at assembly time. */
  readonly root: string | LiveTaskRoot;
}

/**
 * Factory: createCreateWorktreeTool(deps) — the model-facing escape hatch
 * of the isolation gate. Registered whenever the host supplies the provision
 * seam (build-engine threading; worker assembly paths omit it, so the tool
 * never enters a worker tool surface). Presence is decoupled from
 * `isolation.worktreeOnMutate` — the switch arms only the mutate gate
 * (ADR-0037).
 */
export function createCreateWorktreeTool(
  deps: CreateWorktreeToolDeps
): AciToolDef {
  return Object.freeze({
    name: "create-worktree",
    description:
      "Create this conversation's isolated git task worktree, rebind the session root to it, and return the tree path. " +
      "An optional lowercase kebab-case name (2-40 characters) becomes the tree's leaf name; without a valid name " +
      "the conversation id is the leaf, and identity lives in the gitdir sidecar (not the folder name). On success " +
      "the tree exists at <repoRoot>/.iknow/worktrees/<leaf name> on its task branch, and the next wave of tool calls " +
      "in this run lands in the new root, so re-issue the pending workspace write then. Calling it again for the same " +
      "conversation returns the same root. Failures exit typed as kind=branch_exists | worktree_exists | " +
      "worktree_add_failed | rebind_failed | foreign_worktree | not_a_git_repo | git_unavailable; resolve the reported " +
      "leftover tree or branch, then retry.",
    inputSchema: {
      type: "object",
      properties: {
        // Deliberately omit maxLength here: overlong names are a recoverable
        // invalid-label fallback, not an executor validation failure. The
        // handler/provisioner enforce the 40-character contract.
        name: {
          type: "string",
          description: "Optional lowercase kebab-case label, 2-40 characters.",
        },
      },
      additionalProperties: false,
    },
    aci: {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      // `build` (5 min), not `default` (30 s). This tool call now carries
      // a synchronous project-dep install, and a Node install routinely
      // exceeds 30 s (measured on this repo: 53 s for one `npm ci`). At
      // `default` the tier timer fires mid-install and the executor returns a
      // bare `timeout`, silently discarding the install receipt AND leaving
      // the install running detached — the receipt is the entire point of
      // this feature, so the tier has to outlive the work.
      // `build` is the tier bash takes for the same class of work (builds /
      // installs run through it today); the install's own
      // `PACKAGE_MANAGER_INSTALL_TIMEOUT_MS` (120 s) is what actually bounds
      // it, so this raise only guarantees the bound reports first.
      timeoutTier: "build",
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const conversationId = ctx?.conversationId;
      const name = (input as { name?: unknown } | null)?.name;
      const label = resolveTaskWorktreeLabel(name);
      const root = typeof deps.root === "string" ? deps.root : deps.root.read();
      // The host provisioner installs the new tree's project deps and
      // reports the outcome through this channel. The seam stays
      // `Promise<string>` — the gate / hub / live-taskRoot wrapper keep
      // consuming a plain root — and the model still learns
      // linked/skipped/failed for its new tree.
      const depLines: string[] = [];
      try {
        const worktreePath = await deps.provision({
          conversationId,
          root,
          ...(name !== undefined ? { name } : {}),
          report: (line) => depLines.push(line),
        });
        const labelNotice =
          label.reason === undefined
            ? ""
            : ` name discarded: ${label.reason}; actual path: ${worktreePath};`;
        return (
          `task worktree ready:${labelNotice} ${worktreePath} (session root rebound; ` +
          `the next wave of tool calls in this run will land in the new root, ` +
          `re-issue the blocked write then)` +
          (depLines.length > 0 ? ` ${depLines.join(" ")}` : "")
        );
      } catch (err) {
        if (err instanceof WorktreeIsolationError) {
          throw new ToolExecutionError(
            `[create-worktree] kind=${err.kind} — ${err.detail}`
          );
        }
        throw new ToolExecutionError(
          `[create-worktree] provision failed: ${errorMessage(err)}`
        );
      }
    },
  });
}
