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
import type {
  TaskWorktreeInfo,
  WorktreeEnterContext,
  WorktreeEnterResult,
  WorktreeExitContext,
  WorktreeListContext,
  WorktreeProvisionContext,
  WorktreeRemoval,
  WorktreeRemoveContext,
} from "../../src/harness/isolation/worktree-gate.ts";

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

// The TUI entry must expose the WHOLE worktree lifecycle, not just creation:
// a session that creates a task worktree needs the same production path back
// to the main checkout the other host entries get. Each seam forwards the
// complete context untouched (the class of field-drop bug the SSOT exists to
// prevent) and fails closed when the hub is absent.
describe("createTuiWorktreeIsolationHost (TUI lifecycle seams)", () => {
  it("carries enter / exit / list / remove alongside provision", () => {
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
      enterWorktree: async () => ({ path: "/p", receipt: "r" }),
      exitWorktree: async () => "/repo",
      listTaskWorktrees: async () => [],
      removeTaskWorktree: async () => ({
        label: undefined,
        conversationId: "conv-a",
        path: "/p",
        branch: "b",
        head: "h",
        branchDeleted: false,
      }),
    });

    expect(typeof host.provision).toBe("function");
    expect(typeof host.worktreeEnter).toBe("function");
    expect(typeof host.worktreeExit).toBe("function");
    expect(typeof host.worktreeList).toBe("function");
    expect(typeof host.worktreeRemove).toBe("function");
  });

  it("omits a seam's field so its ACI tool stays out of the registry", () => {
    // Gate 3 mirror filter: only the supplied seams become host fields.
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
    });

    expect(typeof host.provision).toBe("function");
    expect(host.worktreeEnter).toBeUndefined();
    expect(host.worktreeExit).toBeUndefined();
    expect(host.worktreeList).toBeUndefined();
    expect(host.worktreeRemove).toBeUndefined();
  });

  it("forwards the whole enter context (conversationId / root / targetConversationId) unchanged", async () => {
    const captured: WorktreeEnterContext[] = [];
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
      enterWorktree: async (ctx) => {
        captured.push(ctx);
        return { path: "/repo/.iknow/worktrees/conv-b", receipt: "entered" };
      },
    });

    const ctx: WorktreeEnterContext = {
      conversationId: "conv-a",
      root: "/repo",
      targetConversationId: "conv-b",
    };
    const result: WorktreeEnterResult = await host.worktreeEnter!(ctx);

    expect(result).toEqual({
      path: "/repo/.iknow/worktrees/conv-b",
      receipt: "entered",
    });
    expect(captured).toEqual([ctx]);
  });

  it("forwards the whole exit context (conversationId / root) unchanged", async () => {
    const captured: WorktreeExitContext[] = [];
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
      exitWorktree: async (ctx) => {
        captured.push(ctx);
        return "/repo";
      },
    });

    const ctx: WorktreeExitContext = {
      conversationId: "conv-a",
      root: "/repo/.iknow/worktrees/conv-a",
    };
    await expect(host.worktreeExit!(ctx)).resolves.toBe("/repo");
    expect(captured).toEqual([ctx]);
  });

  it("forwards the whole list context (root / includeStale) unchanged", async () => {
    const captured: WorktreeListContext[] = [];
    const rows: TaskWorktreeInfo[] = [
      {
        label: "fix-1",
        conversationId: "conv-b",
        path: "/repo/.iknow/worktrees/fix-1",
        branch: "task/fix-1",
        head: "deadbeef",
        dirty: false,
      },
    ];
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
      listTaskWorktrees: async (ctx) => {
        captured.push(ctx);
        return rows;
      },
    });

    const ctx: WorktreeListContext = { root: "/repo", includeStale: true };
    await expect(host.worktreeList!(ctx)).resolves.toEqual(rows);
    expect(captured).toEqual([ctx]);
  });

  it("forwards the whole remove context (root / conversationId / target / deleteBranch) unchanged", async () => {
    const captured: WorktreeRemoveContext[] = [];
    const removal: WorktreeRemoval = {
      label: "fix-1",
      conversationId: "conv-b",
      path: "/repo/.iknow/worktrees/fix-1",
      branch: "task/fix-1",
      head: "deadbeef",
      branchDeleted: true,
    };
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: async () => "/repo/.iknow/worktrees/conv-a",
      removeTaskWorktree: async (ctx) => {
        captured.push(ctx);
        return removal;
      },
    });

    const ctx: WorktreeRemoveContext = {
      root: "/repo",
      conversationId: "conv-a",
      targetConversationId: "conv-b",
      deleteBranch: true,
    };
    await expect(host.worktreeRemove!(ctx)).resolves.toEqual(removal);
    expect(captured).toEqual([ctx]);
  });

  it("propagates the bridge's fail-closed rejection for every lifecycle seam when the hub is absent", async () => {
    // run.tsx bridge delegation semantics: hub absent → `?? Promise.reject`.
    // The shell is pure pass-through; each delegated rejection must cross it
    // verbatim (neither swallowed nor rewritten) so the ACI tool reports the
    // typed failure instead of a silent no-op.
    const host = createTuiWorktreeIsolationHost({
      provisionWorktree: () =>
        Promise.reject(
          new Error("TUI Hub is not ready for worktree provision")
        ),
      enterWorktree: () =>
        Promise.reject(new Error("TUI Hub is not ready for worktree enter")),
      exitWorktree: () =>
        Promise.reject(new Error("TUI Hub is not ready for worktree exit")),
      listTaskWorktrees: () =>
        Promise.reject(new Error("TUI Hub is not ready for worktree list")),
      removeTaskWorktree: () =>
        Promise.reject(new Error("TUI Hub is not ready for worktree remove")),
    });

    await expect(
      host.worktreeEnter!({
        conversationId: "conv-a",
        root: "/repo",
        targetConversationId: "conv-b",
      })
    ).rejects.toThrow("TUI Hub is not ready for worktree enter");
    await expect(
      host.worktreeExit!({ conversationId: "conv-a", root: "/repo" })
    ).rejects.toThrow("TUI Hub is not ready for worktree exit");
    await expect(host.worktreeList!({ root: "/repo" })).rejects.toThrow(
      "TUI Hub is not ready for worktree list"
    );
    await expect(
      host.worktreeRemove!({ root: "/repo", targetConversationId: "conv-b" })
    ).rejects.toThrow("TUI Hub is not ready for worktree remove");
  });
});
