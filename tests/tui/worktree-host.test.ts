/**
 * TUI 入口的 worktree isolation host 缝（src/tui/worktree-host.ts）回归：
 * run.tsx 原内联手工解构只取 { conversationId, root }，把
 * WorktreeProvisionContext 的 `name` 静默丢弃 → TUI 入口所有带名字的
 * create-task-worktree 退化为 UUID-only leaf（编译仍绿）。与 CLI 缝
 * tests/cli/worktree-host.test.ts 同构的本测试接捕获 ctx 的 spy hub，
 * 钉死 TUI 装配层必须整 ctx 透传（含 `name`）； labeled leaf 端到端
 * 形态由 session-api provisioner 侧测试覆盖。
 *
 * 背景（iknow trace dfce6b4f 实测发现，2026-09-05 修复；CLI 同类问题
 * 见 PR #881）。
 */
import { describe, expect, it } from "vitest";

import { createTuiWorktreeIsolationHost } from "../../src/tui/worktree-host.ts";
import type { WorktreeProvisionContext } from "../../src/harness/isolation/worktree-gate.ts";

describe("createTuiWorktreeIsolationHost (TUI provision seam)", () => {
  it("passes the full ctx (including `name`) through to the hub", async () => {
    const captured: WorktreeProvisionContext[] = [];
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async (ctx) => {
        captured.push(ctx);
        return "/repo/.iknow/worktrees/ai-news-archive-2026-09-05--conv-a";
      },
    });

    const ctx: WorktreeProvisionContext = {
      conversationId: "conv-a",
      root: "/repo",
      name: "ai-news-archive-2026-09-05",
    };
    const root = await host.provision(ctx);

    expect(root).toBe(
      "/repo/.iknow/worktrees/ai-news-archive-2026-09-05--conv-a"
    );
    expect(captured).toEqual([ctx]);
    expect(captured[0]?.name).toBe("ai-news-archive-2026-09-05");
  });

  it("still passes a name-less ctx through unchanged", async () => {
    const captured: WorktreeProvisionContext[] = [];
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async (ctx) => {
        captured.push(ctx);
        return "/repo/.iknow/worktrees/conv-b";
      },
    });

    const ctx: WorktreeProvisionContext = {
      conversationId: "conv-b",
      root: "/repo",
    };
    await host.provision(ctx);

    expect(captured).toEqual([ctx]);
    expect("name" in captured[0]! && captured[0]!.name !== undefined).toBe(
      false
    );
  });

  it("fails closed with the not-ready error when the hub is absent", async () => {
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => {
        throw new Error("hub must not be called");
      },
      notReadyError: () => new Error("TUI Hub is not ready"),
    });

    await expect(
      host.provision({ conversationId: "conv-c", root: "/repo" })
    ).rejects.toThrow("TUI Hub is not ready");
  });
});
