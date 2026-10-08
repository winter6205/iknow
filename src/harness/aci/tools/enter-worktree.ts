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
 * `taskWorktreePath`). Since issue #1231 the tool also accepts an optional
 * `path` selector for a linked checkout that lives OUTSIDE the task area (an
 * operator's own worktree): that path must exactly match an entry from
 * `list-worktrees` — the tool takes no free-form path.
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
 * The two mutually exclusive ways to name an enter target (issue #1231).
 * `conversationId` carries an owner id / task label / branch / leaf name;
 * `path` carries an exact path from `list-worktrees`. Both are optional in the
 * schema but exactly one must reach the seam.
 */
interface EnterSelectors {
  readonly target: string | undefined;
  readonly exactPath: string | undefined;
}

/**
 * Input validation for the enter selectors — the one job this tool owns (its
 * module boundary forbids git/fs access here). Extracted so the handler's
 * branch count reflects delegation rather than argument checking.
 *
 * Order is deliberate: shape first (so a non-string is named as such rather
 * than as an absent selector), then presence, then exclusivity, then the
 * segment-safety gate that mirrors what the provisioner enforces host-side.
 */
function parseEnterSelectors(input: unknown): EnterSelectors {
  const raw = (input ?? {}) as {
    conversationId?: unknown;
    path?: unknown;
  };
  // Shape is checked before presence so a non-string is named as malformed
  // rather than silently treated as an absent selector.
  const target = optionalSelector(raw.conversationId, "conversationId");
  const exactPath = optionalSelector(raw.path, "path");
  if (target === undefined && exactPath === undefined) {
    throw new ToolExecutionError(
      "[enter-worktree] provide conversationId (a conversation id, task label, or branch/leaf name) or path (an exact path from list-worktrees)"
    );
  }
  if (target !== undefined && exactPath !== undefined) {
    throw new ToolExecutionError(
      "[enter-worktree] provide either conversationId or path, not both (they are alternative selectors)"
    );
  }
  if (target !== undefined && !SAFE_CONVERSATION_ID_RE.test(target)) {
    // Same typed-exit label as the WorktreeIsolationError mapping below —
    // the provisioner fails this id with kind=rebind_failed too.
    throw new ToolExecutionError(
      `[enter-worktree] kind=rebind_failed — conversationId ${JSON.stringify(target)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$)`
    );
  }
  return { target, exactPath };
}

/** One selector's shape rule: absent is legal, present must be a non-empty string. */
function optionalSelector(
  value: unknown,
  field: "conversationId" | "path"
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError(
      `[enter-worktree] ${field} must be a non-empty string when provided (${
        field === "path"
          ? "an exact path from list-worktrees"
          : "a conversation id, task label, or branch/leaf name"
      })`
    );
  }
  return value;
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
      "Enter an existing git worktree of this repository — a task worktree, or a linked checkout that lives outside the task area (discoverable with list-worktrees) — rebind this session's root to it, and return the entered path. " +
      "Pass the owning conversation id, a unique task label, or a branch/leaf name returned by list-worktrees (for example the tree another conversation created); target resolution uses the repository's naming SSOT instead of a free-form path. " +
      "To enter a checkout that carries no id or label (an operator's own worktree), pass its exact path from the list-worktrees result. " +
      "On success the session root moves to the entered tree, so re-issue pending workspace writes there in the next wave " +
      "of tool calls in this run. Calling it again for the same target returns the same path. Failures exit typed as " +
      "kind=worktree_not_found | ambiguous_worktree | foreign_worktree | rebind_failed | git_unavailable; resolve the " +
      "reported condition (wrong id, tree in another repository, or leftover state), then retry. " +
      "The entered tree stays untouched — its branch and uncommitted changes are preserved and no new worktree is created; exit-worktree returns this session to the main repo root.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description:
            "Conversation id, task-worktree label, branch name, or leaf directory name of the target, as returned by list-worktrees.",
          minLength: 1,
        },
        path: {
          type: "string",
          description:
            "Exact path of the target checkout, taken verbatim from the list-worktrees result; use this for an external checkout that has no conversation id or label.",
          minLength: 1,
        },
      },
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
      const { target, exactPath } = parseEnterSelectors(input);
      try {
        const root =
          typeof deps.root === "string" ? deps.root : deps.root.read();
        const entered = await deps.worktreeEnter({
          conversationId,
          root,
          // The exact-path selector and the id/label selector are mutually
          // exclusive. In path mode `targetConversationId` is left empty and
          // ignored by the host seam, which resolves by exact path against the
          // listing instead of the segment regex.
          targetConversationId: target ?? "",
          ...(exactPath !== undefined ? { path: exactPath } : {}),
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
