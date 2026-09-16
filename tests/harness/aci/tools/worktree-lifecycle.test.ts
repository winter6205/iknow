import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createCreateWorktreeTool,
  type CreateWorktreeProvisionFn,
} from "../../../../src/harness/aci/tools/create-worktree.ts";
import { createListWorktreesTool } from "../../../../src/harness/aci/tools/list-worktrees.ts";
import { createRemoveWorktreeTool } from "../../../../src/harness/aci/tools/remove-worktree.ts";
import { WorktreeIsolationError } from "../../../../src/harness/isolation/worktree-gate.ts";

describe("task worktree lifecycle ACI tools", () => {
  it("passes an optional name to provision and reports a discarded invalid name with the actual path", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provision: CreateWorktreeProvisionFn = async (ctx) => {
      calls.push(ctx);
      return "/repo/.iknow/worktrees/conv-1";
    };
    const tool = createCreateWorktreeTool({
      provision,
      root: "/repo",
    });

    const result = await tool.handler(
      { name: "Bad--Name" },
      { conversationId: "conv-1" }
    );

    assert.equal(calls[0]?.name, "Bad--Name");
    assert.match(
      String(result),
      /name discarded: .*actual path: \/repo\/\.iknow\/worktrees\/conv-1/
    );
  });

  // Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3): the host
  // installs the new tree's project deps and reports the outcome through the
  // provision context's `report` callback. The tool result must carry that
  // line so the model learns linked/skipped/failed instead of inventing an
  // install; the seam itself stays `Promise<string>`.
  it("surfaces the host's project-dep outcome line in the tool result", async () => {
    const provision: CreateWorktreeProvisionFn = async (ctx) => {
      // The host reports through the context channel the tool supplies.
      ctx.report?.("project deps installed with `npm ci` in the worktree");
      return "/repo/.iknow/worktrees/conv-deps";
    };
    const tool = createCreateWorktreeTool({ provision, root: "/repo" });

    const result = String(
      await tool.handler({}, { conversationId: "conv-deps" })
    );

    assert.match(result, /task worktree ready:/);
    assert.match(result, /\/repo\/\.iknow\/worktrees\/conv-deps/);
    assert.match(result, /project deps installed with `npm ci`/);
  });

  it("omits the project-dep line when the host reports nothing", async () => {
    const provision: CreateWorktreeProvisionFn = async () =>
      "/repo/.iknow/worktrees/conv-quiet";
    const tool = createCreateWorktreeTool({ provision, root: "/repo" });

    const result = String(
      await tool.handler({}, { conversationId: "conv-quiet" })
    );

    assert.match(result, /task worktree ready:/);
    assert.doesNotMatch(result, /project deps/);
  });

  it("still fails typed when provision rejects after reporting a dep line", async () => {
    const provision: CreateWorktreeProvisionFn = async (ctx) => {
      ctx.report?.("project deps installed with `npm ci` in the worktree");
      throw new WorktreeIsolationError("worktree_add_failed", "git said no");
    };
    const tool = createCreateWorktreeTool({ provision, root: "/repo" });

    await assert.rejects(
      () => tool.handler({}, { conversationId: "conv-fail" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.match(
          String((error as Error).message),
          /kind=worktree_add_failed/
        );
        return true;
      }
    );
  });

  it("lists worktrees as JSON and preserves the read-only ACI category", async () => {
    const tool = createListWorktreesTool({
      root: "/repo",
      worktreeList: async () => [
        {
          label: "fix-648",
          conversationId: "conv-1",
          path: "/repo/.iknow/worktrees/fix-648--conv-1",
          branch: "iknow/task/fix-648-conv-1",
          head: "abc123",
          dirty: false,
        },
      ],
    });

    const result = JSON.parse(String(await tool.handler({}))) as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(result[0], {
      label: "fix-648",
      conversationId: "conv-1",
      path: "/repo/.iknow/worktrees/fix-648--conv-1",
      branch: "iknow/task/fix-648-conv-1",
      head: "abc123",
      dirty: false,
    });
    assert.equal(tool.aci.category, "read-only");
  });

  it("removes by conversationId or label and forwards delete_branch", async () => {
    let received: Record<string, unknown> | undefined;
    const tool = createRemoveWorktreeTool({
      root: "/repo",
      worktreeRemove: async (ctx) => {
        received = ctx;
        return {
          label: "fix-648",
          conversationId: "conv-1",
          path: "/repo/.iknow/worktrees/fix-648--conv-1",
          branch: "iknow/task/fix-648-conv-1",
          head: "abc123",
          branchDeleted: true,
        };
      },
    });

    const result = JSON.parse(
      String(
        await tool.handler({
          conversationId: "fix-648",
          delete_branch: true,
        })
      )
    ) as Record<string, unknown>;
    assert.equal(received?.targetConversationId, "fix-648");
    assert.equal(received?.deleteBranch, true);
    assert.equal(result.branchDeleted, true);
    assert.equal(tool.aci.category, "write");
  });

  it("maps a typed host failure to an actionable tool error", async () => {
    const tool = createListWorktreesTool({
      root: "/repo",
      worktreeList: async () => {
        throw new ToolExecutionError("git unavailable");
      },
    });

    await assert.rejects(
      () => tool.handler({}),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("git unavailable")
    );
  });

  it("validates lifecycle options before calling the host seam", async () => {
    let calls = 0;
    const list = createListWorktreesTool({
      root: "/repo",
      worktreeList: async () => {
        calls += 1;
        return [];
      },
    });
    const remove = createRemoveWorktreeTool({
      root: "/repo",
      worktreeRemove: async () => {
        calls += 1;
        throw new Error("host should not be reached");
      },
    });

    await assert.rejects(
      () => list.handler({ include_stale: "yes" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("include_stale must be a boolean")
    );
    await assert.rejects(
      () => remove.handler({ conversationId: "../outside" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("safe conversation id or label")
    );
    assert.strictEqual(calls, 0);
  });

  it("renders a WorktreeIsolationError with its stable kind", async () => {
    const tool = createRemoveWorktreeTool({
      root: "/repo",
      worktreeRemove: async () => {
        throw new WorktreeIsolationError(
          "worktree_dirty",
          "task worktree has uncommitted changes"
        );
      },
    });

    await assert.rejects(
      () => tool.handler({ conversationId: "conv-1" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("[remove-worktree] kind=worktree_dirty")
    );
  });
});
