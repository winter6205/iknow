/**
 * SSOT for the shared worktree host provision seam
 * (src/harness/isolation/worktree-host.ts). Regression background: two
 * entry-level hand-written destructurings (cli.ts and tui/run.tsx) really
 * dropped `name`; after that, every entry's provision-seam assembly converged
 * into this factory. This test pins the core invariant: **the full ctx reaches
 * the hub implementation with zero field loss**.
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

    // Pure pass-through semantics: a sync throw from the hub implementation bubbles up
    // sync unchanged (same as the CLI seam), and the executor side catches it via await + try/catch.
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
