/**
 * T4 (plans/worktree-isolation-model-provision.md) — create-task-worktree
 * ACI tool unit tests.
 *
 * The tool is the model-facing entry of the model-provision contract
 * (ADR-0037 amended 2026-08-30): it delegates to the host provision seam
 * (session-api hub), so the unit suite pins ONLY the tool-side contract:
 *   - registration shape (name aligned with T3's
 *     `CREATE_TASK_WORKTREE_TOOL_HINT`, schema, ACI meta);
 *   - conversationId flows from ToolExecutionContext into the provision seam;
 *   - typed failures surface as ToolExecutionError with `kind=<kind>` (the
 *     model-facing error type contract);
 *   - the tool writes nothing itself — every side effect goes through the
 *     provision seam.
 *
 * Integration (real git + hub + gate) lives in
 * tests/session-api/hub-worktree-isolation.test.ts (T4 describe block).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createCreateTaskWorktreeTool,
  type CreateTaskWorktreeProvisionFn,
} from "../../../../src/harness/aci/tools/create-task-worktree.js";
import { createDefaultAciRegistry } from "../../../../src/harness/aci/tools/registry.js";
import {
  CREATE_TASK_WORKTREE_TOOL_HINT,
  WorktreeIsolationError,
} from "../../../../src/harness/isolation/worktree-gate.js";
import { ToolExecutionError } from "../../../../src/harness/errors.js";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.js";

/** Fake provision seam — records calls, returns a canned worktree path. */
function fakeProvision(impl?: CreateTaskWorktreeProvisionFn): {
  calls: Array<{ conversationId?: string; root: string }>;
  provision: CreateTaskWorktreeProvisionFn;
} {
  const calls: Array<{ conversationId?: string; root: string }> = [];
  const provision: CreateTaskWorktreeProvisionFn = async (ctx) => {
    calls.push({ conversationId: ctx.conversationId, root: ctx.root });
    if (impl) return impl(ctx);
    return `${ctx.root}/.iknow/worktrees/${ctx.conversationId}`;
  };
  return { calls, provision };
}

const CTX = (conversationId: string): ToolExecutionContext => ({
  conversationId,
});

describe("create-task-worktree — tool def shape", () => {
  const def = createCreateTaskWorktreeTool({
    provision: fakeProvision().provision,
    root: "/repo",
  });

  it("is named exactly after the T3 gate hint (create-task-worktree)", () => {
    expect(def.name).toBe("create-task-worktree");
    // T3 alignment: the gate block message points at this tool by name.
    expect(`${CREATE_TASK_WORKTREE_TOOL_HINT}`).toContain(def.name);
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

  it("description mentions the isolation notice trigger and the typed kinds", () => {
    expect(def.description).toContain("[worktree_isolation]");
    expect(def.description).toContain("kind=");
    expect(def.description.length).toBeGreaterThan(30);
  });
});

describe("create-task-worktree — handler", () => {
  it("calls the host provision seam with ctx.conversationId and the engine root, returns the worktree path", async () => {
    const { calls, provision } = fakeProvision();
    const def = createCreateTaskWorktreeTool({ provision, root: "/repo" });

    const out = await def.handler({}, CTX("conv-1"));

    expect(calls).toEqual([{ conversationId: "conv-1", root: "/repo" }]);
    expect(String(out)).toContain("/repo/.iknow/worktrees/conv-1");
  });

  it("is idempotent per conversation: a second call goes through the same seam (host no-ops on its own tree)", async () => {
    const { calls, provision } = fakeProvision();
    const def = createCreateTaskWorktreeTool({ provision, root: "/repo" });

    await def.handler({}, CTX("conv-1"));
    await def.handler({}, CTX("conv-1"));

    expect(calls).toHaveLength(2);
  });

  it("maps WorktreeIsolationError to a typed ToolExecutionError carrying kind=<kind>", async () => {
    const def = createCreateTaskWorktreeTool({
      provision: async () => {
        throw new WorktreeIsolationError(
          "branch_exists",
          "task branch 'iknow/task-c1' already exists"
        );
      },
      root: "/repo",
    });

    await expect(def.handler({}, CTX("c1"))).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("kind=branch_exists"),
    });
  });

  it("maps non-typed provision failures to a ToolExecutionError with the tool prefix", async () => {
    const def = createCreateTaskWorktreeTool({
      provision: async () => {
        throw new Error("boom");
      },
      root: "/repo",
    });

    await expect(def.handler({}, CTX("c1"))).rejects.toMatchObject({
      name: "ToolExecutionError",
      message: expect.stringContaining("[create-task-worktree]"),
    });
  });

  it("never writes on failure: a rejecting seam is the only effect (no fs/git side channel in the tool)", async () => {
    const seam = vi.fn(async () => {
      throw new WorktreeIsolationError("worktree_add_failed", "git died");
    });
    const def = createCreateTaskWorktreeTool({
      provision: seam,
      root: "/repo",
    });

    await expect(def.handler({}, CTX("c1"))).rejects.toBeInstanceOf(
      ToolExecutionError
    );
    expect(seam).toHaveBeenCalledTimes(1);
  });
});

describe("create-task-worktree — registry registration (conditional on worktreeProvision)", () => {
  const makeWebEnv = () => ({
    web: { searchUrl: undefined, proxy: undefined },
  });

  it("registered when worktreeProvision is supplied", () => {
    const { provision } = fakeProvision();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
      worktreeProvision: provision,
    });
    const def = reg.catalog.get("create-task-worktree");
    expect(def).toBeDefined();
    expect(def?.name).toBe("create-task-worktree");
  });

  it("absent when worktreeProvision is omitted (switch OFF / worker paths stay byte-identical)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/repo",
    });
    expect(reg.catalog.get("create-task-worktree")).toBeUndefined();
  });

  it("the assembled handler binds the registry's sandboxRoot as the engine root", async () => {
    const { calls, provision } = fakeProvision();
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/engine-root",
      worktreeProvision: provision,
    });
    const def = reg.catalog.get("create-task-worktree");
    await def!.handler({}, CTX("conv-9"));
    expect(calls[0]).toEqual({
      conversationId: "conv-9",
      root: "/engine-root",
    });
  });
});
