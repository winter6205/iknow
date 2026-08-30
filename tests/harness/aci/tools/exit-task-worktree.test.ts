/**
 * T8 (plans/worktree-isolation-model-provision.md) — exit-task-worktree
 * ACI tool unit tests.
 *
 * The tool is the symmetric-exit face of the model-provision contract
 * (ADR-0037 amended 2026-08-30, T8 tool-surface extension): a session
 * currently rebound to a task worktree returns to the MAIN repo root. The
 * tree is PRESERVED (orphan cleanup is a plan non-goal); the tool takes no
 * parameters and delegates every side effect (rebound detection, repo-root
 * derivation, rebind persistence) to the host exit seam (session-api hub
 * via build-engine). The unit suite pins ONLY the tool-side contract:
 *   - registration shape (empty strict schema, ACI meta);
 *   - conversationId flows from ToolExecutionContext into the exit seam;
 *   - typed failures surface as ToolExecutionError with `kind=<kind>`;
 *   - the tool writes nothing itself — every side effect goes through the
 *     exit seam.
 *
 * Integration (real git + hub + gate) lives in
 * tests/session-api/hub-worktree-isolation.test.ts (T8 describe block).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createExitTaskWorktreeTool,
  type WorktreeExitToolDeps,
} from "../../../../src/harness/aci/tools/exit-task-worktree.js";
import { createDefaultAciRegistry } from "../../../../src/harness/aci/tools/registry.js";
import { WorktreeIsolationError } from "../../../../src/harness/isolation/worktree-gate.js";
import { ToolExecutionError } from "../../../../src/harness/errors.js";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.js";

/** Fake exit seam — records calls, returns a canned repo root. */
function fakeExit(impl?: WorktreeExitToolDeps["worktreeExit"]): {
  calls: Array<{ conversationId?: string; root: string }>;
  worktreeExit: NonNullable<WorktreeExitToolDeps["worktreeExit"]>;
} {
  const calls: Array<{ conversationId?: string; root: string }> = [];
  const worktreeExit: NonNullable<WorktreeExitToolDeps["worktreeExit"]> =
    async (ctx) => {
      calls.push({ conversationId: ctx.conversationId, root: ctx.root });
      if (impl) return impl(ctx);
      return "/main-repo";
    };
  return { calls, worktreeExit };
}

const CTX = (conversationId: string): ToolExecutionContext => ({
  conversationId,
});

describe("exit-task-worktree — tool def shape", () => {
  const def = createExitTaskWorktreeTool({
    worktreeExit: fakeExit().worktreeExit,
    root: "/repo/.iknow/worktrees/conv-1",
  });

  it("is named exit-task-worktree", () => {
    expect(def.name).toBe("exit-task-worktree");
  });

  it("takes no parameters (empty schema, strict additionalProperties)", () => {
    expect(def.inputSchema).toEqual({
      type: "object",
      properties: {},
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

  it("description documents the preserved tree, the enter counterpart, and the typed kinds", () => {
    expect(def.description).toContain("enter-task-worktree");
    expect(def.description).toContain("kind=");
    expect(def.description).toContain("preserved");
    expect(def.description.length).toBeGreaterThan(30);
  });
});

describe("exit-task-worktree — handler", () => {
  it("calls the host exit seam with ctx.conversationId and the engine root; reports the repo root", async () => {
    const { calls, worktreeExit } = fakeExit();
    const def = createExitTaskWorktreeTool({
      worktreeExit,
      root: "/repo/.iknow/worktrees/conv-1",
    });

    const out = await def.handler({}, CTX("conv-1"));

    expect(calls).toEqual([
      { conversationId: "conv-1", root: "/repo/.iknow/worktrees/conv-1" },
    ]);
    expect(String(out)).toContain("/main-repo");
  });

  it("maps WorktreeIsolationError to a typed ToolExecutionError carrying kind=<kind>", async () => {
    const def = createExitTaskWorktreeTool({
      worktreeExit: async () => {
        throw new WorktreeIsolationError(
          "rebind_failed",
          "session is not currently rebound to a task worktree"
        );
      },
      root: "/repo",
    });

    await expect(def.handler({}, CTX("conv-1"))).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("kind=rebind_failed"),
    });
  });

  it("maps non-typed seam failures to a ToolExecutionError with the tool prefix", async () => {
    const def = createExitTaskWorktreeTool({
      worktreeExit: async () => {
        throw new Error("boom");
      },
      root: "/repo",
    });

    await expect(def.handler({}, CTX("conv-1"))).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("[exit-task-worktree]"),
    });
  });

  it("never writes on failure: a rejecting seam is the only effect (no fs/git side channel in the tool)", async () => {
    const seam = vi.fn(async () => {
      throw new WorktreeIsolationError("rebind_failed", "not rebound");
    });
    const def = createExitTaskWorktreeTool({
      worktreeExit: seam,
      root: "/repo",
    });

    await expect(def.handler({}, CTX("conv-1"))).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    expect(seam).toHaveBeenCalledTimes(1);
  });
});

describe("exit-task-worktree — registry registration (conditional on worktreeExit)", () => {
  const makeWebEnv = () => ({
    web: { searchUrl: undefined, proxy: undefined },
  });

  it("registered when worktreeExit is supplied", () => {
    const { worktreeExit } = fakeExit();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
      worktreeExit,
    });
    const def = reg.catalog.get("exit-task-worktree");
    expect(def).toBeDefined();
    expect(def?.name).toBe("exit-task-worktree");
  });

  it("absent when worktreeExit is omitted (switch OFF / worker paths stay byte-identical)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
    });
    expect(reg.catalog.get("exit-task-worktree")).toBeUndefined();
  });

  it("the assembled handler binds the registry's sandboxRoot as the engine root", async () => {
    const { calls, worktreeExit } = fakeExit();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/engine-root/.iknow/worktrees/conv-9",
      worktreeExit,
    });
    const def = reg.catalog.get("exit-task-worktree");
    await def!.handler({}, CTX("conv-9"));
    expect(calls[0]).toEqual({
      conversationId: "conv-9",
      root: "/engine-root/.iknow/worktrees/conv-9",
    });
  });
});
