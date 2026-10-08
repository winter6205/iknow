/**
 * src/harness/isolation/recoverability.ts
 *
 * Exhaustive recoverability table for `WorktreeIsolationErrorKind` and the
 * gate-receipt rendering seam.
 *
 * Placement and boundary (kept separate from worktree-gate.ts, which already
 * exceeds the soft review size threshold; this file carries pure data + pure
 * rendering functions):
 *
 *   1. `Recoverability` — the classification axis with at least two members;
 *      `operator_required` means retrying is useless (a structural /
 *      environmental dead end), `model_self_recoverable` means the model can
 *      resolve it with another tool or by parameterizing, and
 *      `rerun_after_change` means "do one thing first, then retry as-is".
 *   2. `RECOVERABILITY` ——`Record<WorktreeIsolationErrorKind, Recoverability>`
 *      **compile-time exhaustive** coverage of the 16 kinds. Missing or
 *      adding one fails `npm run typecheck` — no runtime assertion needed.
 *
 *      - `not_a_git_repo` / `git_unavailable` —— `operator_required`
 *        (structural dead end; this session cannot reach gitdir / the git
 *        binary; further retries only burn turns)
 *      - the other 14 kinds — `model_self_recoverable` (the model can switch
 *        tools / labels / exit, or clean up and then retry; see each detail
 *        wording)
 *
 *   3. `gateBlockNotice(kind, detail)` — the gate rendering seam.
 *      `operator_required` kinds append a stop instruction ("Retry will not
 *      help; report to the operator") and keep the machine-readable `kind=`
 *      prefix (the "machine-readable id in the reason" convention);
 *      `model_self_recoverable` appends nothing, letting the next-step
 *      instruction carried by detail itself (e.g. "switch label" / "retry
 *      after committing") own the receipt.
 *
 *   Does not change the `classifyCall` / `gateMutate` state machine; never
 *   throws / catches `WorktreeIsolationError` here — it only takes
 *   (kind, detail) strings.
 */
import {
  WORKTREE_ISOLATION_PREFIX,
  type WorktreeIsolationErrorKind,
} from "./worktree-gate.js";

/**
 * Recoverability category — at minimum `operator_required` and
 * `model_self_recoverable`; `rerun_after_change` covers the real states of
 * "change one piece of state first, then retry as-is" (e.g. `rebind_failed`
 * usually needs a host reset first). New kinds just land in this union; the
 * exhaustiveness of `RECOVERABILITY` is guaranteed by TypeScript.
 */
export type RecoverabilityCategory =
  "operator_required" | "model_self_recoverable" | "rerun_after_change";

export interface Recoverability {
  readonly category: RecoverabilityCategory;
  /**
   * Classification note; used for diagnostics / doc generation when the
   * exhaustive assertion fails. **Never** enters the receipt.
   */
  readonly note: string;
}

/**
 * Exhaustive classification for every `WorktreeIsolationErrorKind`. The map is
 * declared with `satisfies Record<WorktreeIsolationErrorKind, Recoverability>`
 * so the TypeScript compiler enforces 16 keys = 16 members; missing one is a
 * typecheck failure, not a runtime miss.
 */
export const RECOVERABILITY = {
  not_a_git_repo: {
    category: "operator_required",
    note: "no usable git repository; the session cannot provision a writable root",
  },
  git_unavailable: {
    category: "operator_required",
    note: "git binary cannot be spawned; retrying in the same shell is futile",
  },
  branch_exists: {
    category: "model_self_recoverable",
    note: "task branch already exists; pick a different label or remove the old branch",
  },
  worktree_exists: {
    category: "model_self_recoverable",
    note: "task worktree path exists; enter it (own session) or pick a different label",
  },
  worktree_add_failed: {
    category: "model_self_recoverable",
    note: "git worktree add failed (e.g. empty HEAD); fix the source repo then retry",
  },
  rebind_failed: {
    category: "rerun_after_change",
    note: "host rebind seam rejected the new root; usually transient, retry once",
  },
  foreign_worktree: {
    category: "model_self_recoverable",
    note: "root is another session's task tree; move back to the main repo first",
  },
  worktree_not_found: {
    category: "model_self_recoverable",
    note: "requested task worktree does not exist; correct the id or create it",
  },
  ambiguous_worktree: {
    category: "model_self_recoverable",
    note: "label or id matches multiple trees; disambiguate then retry",
  },
  worktree_list_failed: {
    category: "rerun_after_change",
    note: "git worktree list failed; usually transient, retry once",
  },
  worktree_status_failed: {
    category: "rerun_after_change",
    note: "git status on a task worktree failed; usually transient, retry once",
  },
  worktree_dirty: {
    category: "model_self_recoverable",
    note: "task worktree has uncommitted changes; commit or stash before exit/remove",
  },
  unpublished_commits: {
    category: "model_self_recoverable",
    note: "task worktree has commits not on the task branch; publish or fast-forward",
  },
  current_worktree: {
    category: "model_self_recoverable",
    note: "operation rejected because the session is already on this worktree",
  },
  worktree_remove_failed: {
    category: "model_self_recoverable",
    note: "git worktree remove failed; fix file locks or permissions then retry",
  },
  branch_delete_failed: {
    category: "model_self_recoverable",
    note: "git branch -d failed; the branch is not merged or has untracked refs",
  },
  // Enter-time pre-occupancy check (worktree_claimed) — the target tree is
  // claimed by another live session record (ADR-0070). The model cannot
  // release someone else's claim (release = resume that session and let it
  // exit-worktree / delete that session record), hence operator_required,
  // and the receipt carries the stop instruction automatically.
  worktree_claimed: {
    category: "operator_required",
    note: "task worktree is already claimed by another existing session record; release it via the other session's exit-worktree or by deleting the session record",
  },
  // Issue 1231 — the target is a checkout outside this repository's task
  // worktree area, i.e. one the operator created with their own
  // `git worktree add`. Removing it is an operator decision no model action can
  // reach, so this is operator_required for the same reason as
  // worktree_claimed: retrying only burns turns, and the stop directive is
  // wired in automatically by `gateBlockNotice`.
  external_worktree: {
    category: "operator_required",
    note: "target is an operator-owned checkout outside this repository's task worktree area; remove-worktree only manages task trees it created, so ask the operator to run git worktree remove",
  },
} as const satisfies Record<WorktreeIsolationErrorKind, Recoverability>;

/**
 * Stop-directive suffix for `operator_required` receipts. Model stops retrying
 * the same call surface and surfaces the issue to the operator (CLI / TUI /
 * serve), since continuing to call into the same dead end just burns turns.
 */
const OPERATOR_REQUIRED_SUFFIX =
  "Retry will not help. Report to the operator (the worktree isolation gate cannot resolve this from the model side).";

/**
 * Gate block notice renderer — the SINGLE seam the gate uses to compose
 * `kind=` + `detail` into a `[worktree_isolation]`-prefixed receipt. Kept here
 * so the `operator_required` stop-directive policy lives next to the
 * classification table, not scattered across the gate.
 *
 * Composition rule:
 *   - prefix: `[worktree_isolation]` (SSOT constant `WORKTREE_ISOLATION_PREFIX`).
 *   - body: `kind=<kind> <detail>` (machine-readable id first, mirroring the
 *     `HardRuleSpec.reasonFor` convention).
 *   - operator_required tail: append a stop-directive sentence so the receipt
 *     tells the model "do not retry, surface to the operator" instead of just
 *     diagnosing the dead end.
 *   - model_self_recoverable / rerun_after_change: NO tail — the detail itself
 *     carries the actionable next step; appending a stop-directive would
 *     conflict with the rule "the notice must not steer the model's next move into
 *     building a tree" applied broadly.
 */
export function gateBlockNotice(
  kind: WorktreeIsolationErrorKind,
  detail: string
): string {
  const head = `${WORKTREE_ISOLATION_PREFIX} kind=${kind} ${detail}`;
  if (RECOVERABILITY[kind].category === "operator_required") {
    return `${head} ${OPERATOR_REQUIRED_SUFFIX}`;
  }
  return head;
}
