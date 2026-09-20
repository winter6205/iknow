/**
 * Exhaustive recoverability table + `operator_required` stop directives.
 *
 * Pins the contract of `src/harness/isolation/recoverability.ts`:
 *   - `Recoverability` type (at least `operator_required` and
 *     `model_self_recoverable`);
 *   - `RECOVERABILITY: Record<WorktreeIsolationErrorKind, Recoverability>`
 *     — compile-time exhaustive over all kinds; a missing kind fails `npm run typecheck`;
 *   - `gateBlockNotice(kind, detail): string` — the gate's rendering seam;
 *     operator_required kinds add stop-directive semantics ("retrying is
 *     useless / report to the operator") and keep the machine-readable
 *     `kind=` prefix (following the existing `HardRuleSpec.reasonFor` convention).
 *
 * Coverage (five input classes):
 *   - overflow: every kind has a classification (extra key-count sanity check;
 *     typecheck is the main defense);
 *   - negative: `operator_required` notices must NOT contain substrings that
 *     lure the model into retrying, e.g. `create-worktree` / `enter-worktree`;
 *   - exception: `not_a_git_repo` / `git_unavailable` notices contain both a
 *     "Retry will not help"-equivalent stop directive + machine-readable
 *     `kind=`, prefixed with `[worktree_isolation]`;
 *   - empty: unknown kinds are caught by the `Record` union (typecheck
 *     guarantees coverage; runtime checks the key count).
 */
import { describe, expect, it } from "vitest";

import {
  RECOVERABILITY,
  gateBlockNotice,
} from "../../../src/harness/isolation/recoverability.ts";
import {
  WorktreeIsolationError,
  WORKTREE_ISOLATION_PREFIX,
  createWorktreeIsolationExecutor,
  type WorktreeIsolationErrorKind,
} from "../../../src/harness/isolation/worktree-gate.ts";
import { createLiveTaskRoot } from "../../../src/harness/session-roots.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

// -- helpers for executor integration tests (same style as worktree-gate.test.ts) --

/** Fake inner executor: records executeAll invocations. */
function fakeInner() {
  const calls: { calls: ToolCall[][] } = { calls: [] };
  const inner: Executor = {
    executeAll: async (batch) => {
      calls.calls.push([...batch]);
      return batch.map((): ToolExecutionResult => ({
        kind: "ok",
        toolUseId: "x",
      }));
    },
  };
  return { inner, calls };
}

const writeCall = (id = "c1"): ToolCall => ({
  id,
  name: "write_file",
  input: { path: "a.txt", content: "x" },
});

// -- overflow: every kind has a classification ---------------------------------

const ALL_KINDS: readonly WorktreeIsolationErrorKind[] = [
  "not_a_git_repo",
  "git_unavailable",
  "branch_exists",
  "worktree_exists",
  "worktree_add_failed",
  "rebind_failed",
  "foreign_worktree",
  "worktree_not_found",
  "ambiguous_worktree",
  "worktree_list_failed",
  "worktree_status_failed",
  "worktree_dirty",
  "unpublished_commits",
  "current_worktree",
  "worktree_remove_failed",
  "branch_delete_failed",
  // ADR-0070 — rejection kind from the pre-`enter` occupancy check
  // (classification-table row; operator_required — the model cannot release
  // someone else's claim; see assertNotClaimed in worktree-rebind.ts).
  "worktree_claimed",
];

describe("RECOVERABILITY — SC6 编译期穷尽", () => {
  it("覆盖全部 17 个 kind（typecheck 是主防线，此处为防呆）", () => {
    expect(Object.keys(RECOVERABILITY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("每个 kind 都有一份分类（category ∈ {operator_required, model_self_recoverable, rerun_after_change}）", () => {
    for (const k of ALL_KINDS) {
      const entry = RECOVERABILITY[k];
      expect(entry).toBeDefined();
      expect([
        "operator_required",
        "model_self_recoverable",
        "rerun_after_change",
      ]).toContain(entry.category);
    }
  });
});

// -- exception + negative: stop directives + machine-readable kind for operator_required --

describe("RECOVERABILITY — operator_required 分类", () => {
  it("not_a_git_repo 、 git_unavailable 与 worktree_claimed 归 operator_required（结构死路）", () => {
    expect(RECOVERABILITY.not_a_git_repo.category).toBe("operator_required");
    expect(RECOVERABILITY.git_unavailable.category).toBe("operator_required");
    expect(RECOVERABILITY.worktree_claimed.category).toBe("operator_required");
  });
});

describe("gateBlockNotice — operator_required 停止指令语义", () => {
  it("not_a_git_repo 回执同时含「重试无用」停止指令 + 机读 kind + 门禁前缀", () => {
    const notice = gateBlockNotice("not_a_git_repo", "no gitdir found: /tmp/x");
    expect(notice.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    expect(notice).toContain("kind=not_a_git_repo");
    expect(notice).toContain("Retry will not help");
    expect(notice).toContain("Report to the operator");
    // Do not lure the model into retrying: negative arm — no mention of create-worktree / enter-worktree
    expect(notice).not.toContain("create-worktree");
    expect(notice).not.toContain("enter-worktree");
    // detail passes through
    expect(notice).toContain("no gitdir found: /tmp/x");
  });

  it("git_unavailable 回执同形（沿用 operator_required 停止指令）", () => {
    const notice = gateBlockNotice(
      "git_unavailable",
      "git is not available (spawn failed): ENOENT"
    );
    expect(notice.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    expect(notice).toContain("kind=git_unavailable");
    expect(notice).toContain("Retry will not help");
    expect(notice).toContain("Report to the operator");
  });

  it("worktree_claimed 回执同形（归 operator_required；T3 / ADR-0070）", () => {
    const notice = gateBlockNotice(
      "worktree_claimed",
      "task worktree /repo/.iknow/worktrees/conv-x is already claimed by session 'conv-y'"
    );
    expect(notice.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    expect(notice).toContain("kind=worktree_claimed");
    expect(notice).toContain("Retry will not help");
    expect(notice).toContain("Report to the operator");
    // detail passes through — both the claiming session id and the release-path wording must reach the notice
    expect(notice).toContain("conv-y");
    expect(notice).toContain("/repo/.iknow/worktrees/conv-x");
  });
});

// -- the rendering seam adds no stop directive for model_self_recoverable kinds ------

describe("gateBlockNotice — model_self_recoverable 类不含停止指令", () => {
  it("branch_exists / worktree_exists / worktree_not_found 不附停止指令", () => {
    for (const k of [
      "branch_exists",
      "worktree_exists",
      "worktree_not_found",
      "worktree_add_failed",
      "rebind_failed",
      "foreign_worktree",
    ] as const) {
      const notice = gateBlockNotice(k, "some detail");
      expect(notice).toContain(`kind=${k}`);
      expect(notice).toContain("some detail");
      // no stop directive, which only operator_required kinds carry
      expect(notice).not.toContain("Retry will not help");
      expect(notice).not.toContain("Report to the operator");
    }
  });
});

// -- the gate really uses the rendering seam (regression guard: worktree-gate.ts takes this path) --

describe("gateBlockNotice — 门禁接渲染点（pending → catch 路径）", () => {
  // The real rendering seam is the pending -> catch branch in worktree-gate.ts:
  // when provision throws a typed `WorktreeIsolationError`, the notice must come
  // from gateBlockNotice — so operator_required stop directives reach real
  // notices, not just unit tests.
  it("provision 抛 not_a_git_repo 时，executor 回执含停止指令 + 机读 kind", async () => {
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async () => {
        throw new WorktreeIsolationError(
          "not_a_git_repo",
          "no usable git repository: /repo"
        );
      },
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(out[0]!.kind).toBe("execution_failed");
    const message = out[0]!.message!;
    expect(message.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    expect(message).toContain("kind=not_a_git_repo");
    expect(message).toContain("Retry will not help");
    expect(message).toContain("Report to the operator");
    // inner never reached -> fail-closed (zero writes to the main repo)
    expect(calls.calls).toHaveLength(0);
  });
});
