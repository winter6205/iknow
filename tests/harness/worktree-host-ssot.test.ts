/**
 * 共享 worktree host provision 缝 SSOT（src/harness/isolation/worktree-host.ts）
 * 回归：cli.ts（PR #881）与 tui/run.tsx（2026-09-05 trace dfce6b4f）两次
 * 入口级手工解构丢 `name` 的真 bug 之后，所有入口的 provision 缝装配收敛
 * 到本工厂。本测试钉死核心不变式：**整 ctx 到达 hub 实现，零字段损失**。
 */
import { describe, expect, it } from "vitest";

import { createWorktreeHostProvision } from "../../src/harness/isolation/worktree-host.ts";
import type { WorktreeProvisionContext } from "../../src/harness/isolation/worktree-gate.ts";

describe("createWorktreeHostProvision (shared provision seam SSOT)", () => {
  it("passes the full ctx (including `name`) through unchanged", async () => {
    const captured: WorktreeProvisionContext[] = [];
    const { provision } = createWorktreeHostProvision({
      provisionWorktree: async (ctx) => {
        captured.push(ctx);
        return "/repo/.iknow/worktrees/fix-parser-cache--conv-a";
      },
    });

    const ctx: WorktreeProvisionContext = {
      conversationId: "conv-a",
      root: "/repo",
      name: "fix-parser-cache",
    };
    const root = await provision(ctx);

    expect(root).toBe("/repo/.iknow/worktrees/fix-parser-cache--conv-a");
    expect(captured).toEqual([ctx]);
  });

  it("propagates sync fail-closed throws from the hub implementation", () => {
    const { provision } = createWorktreeHostProvision({
      provisionWorktree: () => {
        throw new Error("TUI Hub is not ready for worktree provision");
      },
    });

    // 纯透传语义：hub 实现的同步 throw 原样同步冒泡（与 PR #881 前后
    // 的 CLI 缝行为一致），executor 侧 await + try/catch 承接。
    expect(() =>
      provision({ conversationId: "conv-b", root: "/repo" })
    ).toThrow("TUI Hub is not ready");
  });

  it("propagates typed WorktreeIsolationError detail from the provisioner", async () => {
    const { provision } = createWorktreeHostProvision({
      provisionWorktree: async () => {
        const err = new Error(
          "worktree isolation: foreign task tree is never written or rebound"
        );
        err.name = "WorktreeIsolationError";
        throw err;
      },
    });

    await expect(
      provision({ conversationId: "conv-c", root: "/repo" })
    ).rejects.toThrow("foreign task tree");
  });
});
