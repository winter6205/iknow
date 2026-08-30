/**
 * T7 (plans/worktree-isolation-model-provision.md) — enter-task-worktree
 * ACI tool unit tests.
 *
 * The tool is the explicit-enter face of the model-provision contract
 * (ADR-0037 amended 2026-08-30, T7 tool-surface extension): it lets a session
 * anchored at the main repo adopt an EXISTING task worktree of this
 * repository (including another conversation's tree) by passing the owner's
 * conversationId. The tool delegates every side effect (tree validation,
 * rebind, persistence) to the host enter seam (session-api hub via
 * build-engine), so the unit suite pins ONLY the tool-side contract:
 *   - registration shape (input schema requires conversationId, ACI meta);
 *   - input validation: conversationId must be a string and a safe
 *     path/branch segment (the SSOT regex lives in worktree-gate.ts);
 *   - typed failures surface as ToolExecutionError with `kind=<kind>`;
 *   - the tool writes nothing itself — every side effect goes through the
 *     enter seam.
 *
 * Integration (real git + hub + gate) lives in
 * tests/session-api/hub-worktree-isolation.test.ts (T7 describe block).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createEnterTaskWorktreeTool,
  type WorktreeEnterToolDeps,
} from "../../../../src/harness/aci/tools/enter-task-worktree.js";
import { createDefaultAciRegistry } from "../../../../src/harness/aci/tools/registry.js";
import {
  SAFE_CONVERSATION_ID_RE,
  WorktreeIsolationError,
} from "../../../../src/harness/isolation/worktree-gate.js";
import { ToolExecutionError } from "../../../../src/harness/errors.js";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.js";

/** Fake enter seam — records calls, returns a canned target path. */
function fakeEnter(impl?: WorktreeEnterToolDeps["worktreeEnter"]): {
  calls: Array<{
    conversationId?: string;
    root: string;
    targetConversationId: string;
  }>;
  worktreeEnter: NonNullable<WorktreeEnterToolDeps["worktreeEnter"]>;
} {
  const calls: Array<{
    conversationId?: string;
    root: string;
    targetConversationId: string;
  }> = [];
  const worktreeEnter: NonNullable<WorktreeEnterToolDeps["worktreeEnter"]> =
    async (ctx) => {
      calls.push({
        conversationId: ctx.conversationId,
        root: ctx.root,
        targetConversationId: ctx.targetConversationId,
      });
      if (impl) return impl(ctx);
      return `${ctx.root}/.iknow/worktrees/${ctx.targetConversationId}`;
    };
  return { calls, worktreeEnter };
}

const CTX = (conversationId: string): ToolExecutionContext => ({
  conversationId,
});

describe("enter-task-worktree — tool def shape", () => {
  const def = createEnterTaskWorktreeTool({
    worktreeEnter: fakeEnter().worktreeEnter,
    root: "/repo",
  });

  it("is named enter-task-worktree", () => {
    expect(def.name).toBe("enter-task-worktree");
  });

  it("requires exactly one string parameter conversationId (strict schema)", () => {
    expect(def.inputSchema).toEqual({
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: expect.any(String),
          minLength: 1,
        },
      },
      required: ["conversationId"],
      additionalProperties: false,
    });
  });

  it("carries ACI meta: write / serialized / block / default tier", () => {
    expect(def.aci).toEqual({
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    });
  });

  it("description mentions the owner conversationId input, the typed kinds, and the exit counterpart", () => {
    expect(def.description).toContain("conversationId");
    expect(def.description).toContain("kind=");
    expect(def.description).toContain("exit-task-worktree");
    expect(def.description.length).toBeGreaterThan(30);
  });
});

describe("enter-task-worktree — handler", () => {
  it("calls the host enter seam with ctx.conversationId, the engine root, and the target conversationId; returns the entered path", async () => {
    const { calls, worktreeEnter } = fakeEnter();
    const def = createEnterTaskWorktreeTool({ worktreeEnter, root: "/repo" });

    const out = await def.handler({ conversationId: "conv-a" }, CTX("conv-b"));

    expect(calls).toEqual([
      {
        conversationId: "conv-b",
        root: "/repo",
        targetConversationId: "conv-a",
      },
    ]);
    expect(String(out)).toContain("/repo/.iknow/worktrees/conv-a");
  });

  it("rejects a missing / non-string conversationId before touching the seam", async () => {
    const { calls, worktreeEnter } = fakeEnter();
    const def = createEnterTaskWorktreeTool({ worktreeEnter, root: "/repo" });

    await expect(def.handler({}, CTX("conv-b"))).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    await expect(
      def.handler({ conversationId: 42 }, CTX("conv-b"))
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(calls).toEqual([]);
  });

  it("rejects a non-segment-safe conversationId with the SSOT regex before touching the seam", async () => {
    const { calls, worktreeEnter } = fakeEnter();
    const def = createEnterTaskWorktreeTool({ worktreeEnter, root: "/repo" });

    for (const bad of ["../evil", "a/b", "-lead", "white space"]) {
      expect(SAFE_CONVERSATION_ID_RE.test(bad)).toBe(false);
      await expect(
        def.handler({ conversationId: bad }, CTX("conv-b"))
      ).rejects.toMatchObject({
        name: "ToolExecutionError",
        message: expect.stringContaining("[enter-task-worktree]"),
      });
    }
    expect(calls).toEqual([]);
  });

  it("maps WorktreeIsolationError to a typed ToolExecutionError carrying kind=<kind>", async () => {
    const def = createEnterTaskWorktreeTool({
      worktreeEnter: async () => {
        throw new WorktreeIsolationError(
          "worktree_not_found",
          "no task worktree at /repo/.iknow/worktrees/conv-a"
        );
      },
      root: "/repo",
    });

    await expect(
      def.handler({ conversationId: "conv-a" }, CTX("conv-b"))
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("kind=worktree_not_found"),
    });
  });

  it("maps non-typed seam failures to a ToolExecutionError with the tool prefix", async () => {
    const def = createEnterTaskWorktreeTool({
      worktreeEnter: async () => {
        throw new Error("boom");
      },
      root: "/repo",
    });

    await expect(
      def.handler({ conversationId: "conv-a" }, CTX("conv-b"))
    ).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("[enter-task-worktree]"),
    });
  });

  it("never writes on failure: a rejecting seam is the only effect (no fs/git side channel in the tool)", async () => {
    const seam = vi.fn(async () => {
      throw new WorktreeIsolationError("foreign_worktree", "not this repo");
    });
    const def = createEnterTaskWorktreeTool({
      worktreeEnter: seam,
      root: "/repo",
    });

    await expect(
      def.handler({ conversationId: "conv-a" }, CTX("conv-b"))
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(seam).toHaveBeenCalledTimes(1);
  });
});

describe("enter-task-worktree — registry registration (conditional on worktreeEnter)", () => {
  const makeWebEnv = () => ({
    web: { searchUrl: undefined, proxy: undefined },
  });

  it("registered when worktreeEnter is supplied", () => {
    const { worktreeEnter } = fakeEnter();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
      worktreeEnter,
    });
    const def = reg.catalog.get("enter-task-worktree");
    expect(def).toBeDefined();
    expect(def?.name).toBe("enter-task-worktree");
  });

  it("absent when worktreeEnter is omitted (switch OFF / worker paths stay byte-identical)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
    });
    expect(reg.catalog.get("enter-task-worktree")).toBeUndefined();
  });

  it("the assembled handler binds the registry's sandboxRoot as the engine root", async () => {
    const { calls, worktreeEnter } = fakeEnter();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/engine-root",
      worktreeEnter,
    });
    const def = reg.catalog.get("enter-task-worktree");
    await def!.handler({ conversationId: "conv-a" }, CTX("conv-9"));
    expect(calls[0]).toEqual({
      conversationId: "conv-9",
      root: "/engine-root",
      targetConversationId: "conv-a",
    });
  });
});
