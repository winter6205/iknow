/**
 * Regression for the TUI-entry worktree isolation host seam (src/tui/worktree-host.ts):
 * run.tsx formerly inline-destructured only { conversationId, root }, silently
 * dropping WorktreeProvisionContext's `name` → every named create-worktree from
 * the TUI entry degraded to a UUID-only leaf (still compiling). The old
 * registration name `create-task-worktree` was renamed per ADR-0082.
 * Mirrors tests/cli/worktree-host.test.ts: a spy hub captures ctx to pin that
 * the TUI assembly must pass the full ctx through (including `name`); the
 * labeled-leaf end-to-end shape is covered by session-api provisioner tests.
 * Bug surfaced by a real trace run.
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

  it("propagates the bridge's fail-closed rejection when the hub is absent", async () => {
    // run.tsx bridge delegation semantics: hub absent → `?? Promise.reject`.
    // The shell is pure pass-through (fail-closed belongs to the bridge layer);
    // this case pins that the delegated rejection crosses the shell verbatim
    // to the executor side — neither swallowed nor rewritten.
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: () =>
        Promise.reject(
          new Error("TUI Hub is not ready for worktree provision")
        ),
    });

    await expect(
      host.provision({ conversationId: "conv-c", root: "/repo" })
    ).rejects.toThrow("TUI Hub is not ready");
  });
});
