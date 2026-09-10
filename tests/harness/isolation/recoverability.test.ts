/**
 * T7 (plans/write-situation-disclosure.md) — 可恢复性穷尽表 + `operator_required`
 * 停止指令（specs/write-situation-disclosure.md SC6 / SC7）。
 *
 * 落点：
 *   - 新增 `src/harness/isolation/recoverability.ts`，导出：
 *       * `Recoverability` 类型（至少 `operator_required` 与 `model_self_recoverable`
 *         两类）；
 *       * `RECOVERABILITY: Record<WorktreeIsolationErrorKind, Recoverability>`
 *         ——编译期穷尽 16 个 kind；漏一个则 `npm run typecheck` 失败；
 *       * `gateBlockNotice(kind, detail): string` ——门禁渲染缝；operator_required
 *         类附加停止指令语义（"重试无用 / 报给操作员"），并保留机读 `kind=` 前缀
 *         （沿用 PR #947 `HardRuleSpec.reasonFor` 惯例）。
 *
 * 测试覆盖（输入五类 B 表）：
 *   - overflow：16 个 kind 全有分类（额外加防呆 key 数断言，typecheck 是主防线）；
 *   - negative：`operator_required` 类的回执**不含** `create-worktree` /
 *     `enter-worktree` 等会引诱模型再试的子串；
 *   - exception：`not_a_git_repo` / `git_unavailable` 的回执同时含「Retry will
 *     not help」等价停止指令 + 机读 `kind=`，并打 `[worktree_isolation]` 前缀；
 *   - empty：未知 kind 由 `Record` 联合兜底（typecheck 已保证覆盖；runtime 测
 *     `RECOVERABILITY` 含 16 个键）。
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

// -- executor 集成测试的 helper（与 worktree-gate.test.ts 同款） ----------------

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

// -- overflow：16 个 kind 全有分类 --------------------------------------------

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
  // T3 / plans/worktree-exclusive-lock.md / ADR-0070 — enter 前置占用
  // 检查的拒收 kind（spec SC6 分类表行；归 operator_required 模型无法
  // 解掉别人占用，详见 worktree-rebind.ts assertNotClaimed）。
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

// -- exception + negative：operator_required 类的停止指令 + 机读 kind ---------

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
    // 不引诱模型再试：negative 臂——不点名 create-worktree / enter-worktree
    expect(notice).not.toContain("create-worktree");
    expect(notice).not.toContain("enter-worktree");
    // detail 透传
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
    // detail 透传 — 占用者 id 与释放路径文案都得进回执
    expect(notice).toContain("conv-y");
    expect(notice).toContain("/repo/.iknow/worktrees/conv-x");
  });
});

// -- 渲染缝对 model_self_recoverable 不加停止指令（不喧宾夺主） ----------------

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
      // 不加 operator_required 才有的停止指令
      expect(notice).not.toContain("Retry will not help");
      expect(notice).not.toContain("Report to the operator");
    }
  });
});

// -- 渲染缝被门禁实际使用（防回归：worktree-gate.ts 真的走这条路径） -----------

describe("gateBlockNotice — 门禁接渲染点（pending → catch 路径）", () => {
  // 真实的渲染缝在 worktree-gate.ts 的 pending → catch 分支：provision 抛
  // typed `WorktreeIsolationError` 时，回执必须来自 gateBlockNotice——
  // operator_required 类（如 not_a_git_repo）的停止指令才真的进回执，
  // 而非只在单测里成立。
  it("provision 抛 not_a_git_repo 时，executor 回执含停止指令 + 机读 kind", async () => {
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
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
    // inner 未触达 → fail-closed（main repo 零写）
    expect(calls.calls).toHaveLength(0);
  });
});
