/**
 * src/harness/isolation/recoverability.ts
 *
 * T7 (plans/write-situation-disclosure.md) — `WorktreeIsolationErrorKind` 的可
 * 恢复性穷尽表 + 门禁回执渲染缝（specs/write-situation-disclosure.md SC6 /
 * SC7）。
 *
 * 落点与边界（与 worktree-gate.ts 分离——后者已 1167 行 / 远超 500 行 soft
 * REVIEW 阈值，ACR note a；本文件承载纯数据 + 纯渲染函数）：
 *
 *   1. `Recoverability` ——最少两类的分类轴；`operator_required` 表示重试无
 *      用（结构性 / 环境性死路），`model_self_recoverable` 表示模型可凭另一
 *      工具或参数化解，`rerun_after_change` 表示「先做一件事再原样重试」。
 *   2. `RECOVERABILITY` ——`Record<WorktreeIsolationErrorKind, Recoverability>`
 *      **编译期穷尽** 16 个 kind。漏一个 / 多一个均使 `npm run typecheck` 失
 *      败——SC6 不靠断言兜底。已冻结分类：
 *
 *      - `not_a_git_repo` / `git_unavailable` —— `operator_required`
 *        （结构死路；本会话拿不到 gitdir / git 二进制；继续重试只会烧回合）
 *      - 其它 14 种 —— `model_self_recoverable`（模型可换工具 / 换 label /
 *        退出 / 清理后重试；详见各自 detail 措辞）
 *
 *   3. `gateBlockNotice(kind, detail)` ——门禁渲染缝。`operator_required` 类
 *      附加停止指令（"Retry will not help; report to the operator"），保持
 *      机读 `kind=` 前缀（沿用 PR #947 `HardRuleSpec.reasonFor` 建立的「机读
 *      id 进 reason」惯例）；`model_self_recoverable` 不附加，让 detail 自身
 *      携带的下一步指令（如「换 label」/「commit 后再试」）独占回执。
 *
 *   不改 `classifyCall` / `gateMutate` 状态机（spec Changes 已冻结）；不在
 *   此处抛 / 接 `WorktreeIsolationError`——只吃 (kind, detail) 字符串。
 */
import {
  WORKTREE_ISOLATION_PREFIX,
  type WorktreeIsolationErrorKind,
} from "./worktree-gate.js";

/**
 * Recoverability category — at minimum `operator_required` 与 `model_self_recoverable`
 * 两类（spec 决议）；`rerun_after_change` 用于「先做一次状态变更再原样重试」的
 * 真态（如 `rebind_failed` 通常需要先 host 重置）。新增 kind 落到此联合即可，
 * `RECOVERABILITY` 穷尽性由 TypeScript 保证。
 */
export type RecoverabilityCategory =
  "operator_required" | "model_self_recoverable" | "rerun_after_change";

export interface Recoverability {
  readonly category: RecoverabilityCategory;
  /**
   * 分类备注；用于穷尽断言失败时的诊断与文档生成。
   * **不进**回执。
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
 * Composition rule (spec SC6 / SC7):
 *   - prefix: `[worktree_isolation]` (SSOT constant `WORKTREE_ISOLATION_PREFIX`).
 *   - body: `kind=<kind> <detail>` (machine-readable id first, mirroring PR #947
 *     `HardRuleSpec.reasonFor` convention).
 *   - operator_required tail: append a stop-directive sentence so the receipt
 *     tells the model "do not retry, surface to the operator" instead of just
 *     diagnosing the dead end.
 *   - model_self_recoverable / rerun_after_change: NO tail — the detail itself
 *     carries the actionable next step; appending a stop-directive would
 *     conflict with SC7 "the notice must not steer the model's next move into
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
