/**
 * T5 (plans/worktree-isolation-model-provision.md) — build-engine wiring:
 * subagents inherit the rebound session root.
 *
 * Chain pinned here (module-mock seam, same strategy as
 * build-engine-subagent-trace.test.ts):
 *   - when the engine is (re)built at a task-worktree root
 *     (`<any>/.iknow/worktrees/<conversationId>`, the post-rebind shape the
 *     hub / CLI rebuild paths pass as cwd/workspaceRoot), the production
 *     spawn factory receives that root as the worker child's sessionRoot AND
 *     the manager receives it as the parent sandboxRoot — so the spawned
 *     worker's cwd and sandbox are the SAME task worktree (no second tree,
 *     no re-provision: the worker registry never carries the isolation
 *     seam, pinned by tests/subagent/worker-tool-surface.test.ts);
 *   - an engine on a NON-task-worktree root (main repo, unbound) passes NO
 *     sessionRoot — spawn behavior is byte-identical to today
 *     (acceptance: unbound sessions unchanged).
 *
 * The spawn factory's cwd option itself (real child process) is pinned in
 * tests/subagent/spawn-cwd.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// vi.hoisted shared state: captured createDefaultSubAgentSpawn args +
// captured createSubAgentManager opts.
const mockState = vi.hoisted(() => ({
  spawnFactoryArgs: [] as Array<{
    readonly traceDir: unknown;
    readonly workspaceRoot: unknown;
    readonly projectIdentityRoot: unknown;
    readonly installRoot: unknown;
    readonly sessionRoot: unknown;
  }>,
  managerOpts: undefined as { readonly sandboxRoot?: string } | undefined,
}));

vi.mock("../../src/harness/subagent/spawn.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/harness/subagent/spawn.ts")>();
  return {
    ...actual,
    createDefaultSubAgentSpawn: vi.fn(
      (
        opts: {
          readonly traceDir?: string;
          readonly workspaceRoot?: string;
          readonly projectIdentityRoot?: string;
          readonly installRoot?: string;
          readonly sessionRoot?: string;
        } = {}
      ) => {
        mockState.spawnFactoryArgs.push({
          traceDir: opts.traceDir,
          workspaceRoot: opts.workspaceRoot,
          projectIdentityRoot: opts.projectIdentityRoot,
          installRoot: opts.installRoot,
          sessionRoot: opts.sessionRoot,
        });
        // fake spawn factory: build-engine only wires it into the manager;
        // the manager is mocked below with a fake child, so this is never run.
        return (() => {
          throw new Error("no real worker child in this test");
        }) as never;
      }
    ),
  };
});

vi.mock("../../src/harness/subagent/manager.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/harness/subagent/manager.ts")
    >();
  const realCreate = actual.createSubAgentManager;
  return {
    ...actual,
    createSubAgentManager: vi.fn((opts: { readonly sandboxRoot?: string }) => {
      mockState.managerOpts = opts;
      const fakeSpawn = () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr,
          pid: 12345,
          kill: vi.fn(() => true),
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
        });
        return child as unknown as ChildProcess;
      };
      return realCreate({
        ...opts,
        spawn: fakeSpawn as never,
      });
    }),
  };
});

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
  };
}

let scratchDir: string;
let repoDir: string;
let built: BuiltEngine | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "iknow-bld-spawn-root-"));
  // main-repo-looking root (NOT task-worktree-shaped)
  repoDir = mkdtempSync(join(tmpdir(), "iknow-bld-spawn-repo-"));
  mockState.spawnFactoryArgs = [];
  mockState.managerOpts = undefined;
});

afterEach(async () => {
  if (built) {
    await built.shutdown?.();
    built = undefined;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("buildHarnessEngine — subagent spawn inherits the rebound root (T5)", () => {
  it("task-worktree root: spawn factory gets the worktree as sessionRoot; manager sandboxRoot is the worktree", async () => {
    const wtRoot = join(repoDir, ".iknow", "worktrees", "conv-t5");
    mkdirSync(wtRoot, { recursive: true });
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-spawn-root-1"),
      askUser: createNoAskUser(),
      // post-rebind engine shape: hub buildProductionEngine / CLI rebuildDeps
      // pass cwd = workspaceRoot = the task worktree
      cwd: wtRoot,
      workspaceRoot: wtRoot,
      productRoot: repoDir,
    });

    expect(built.subagentManager).toBeDefined();
    expect(mockState.spawnFactoryArgs).toHaveLength(1);
    const args = mockState.spawnFactoryArgs[0]!;
    // the worker child starts inside the rebound root
    expect(args.sessionRoot).toBe(wtRoot);
    // workspace-root env SSOT unchanged
    expect(args.workspaceRoot).toBe(wtRoot);
    // T3 (plans/worktree-session-roots.md): 身份根不跟树走 —— worker 的
    // rules / 项目 AGENTS.md / 项目 skills 仍读主仓。
    expect(args.projectIdentityRoot).toBe(repoDir);
    expect(args.projectIdentityRoot).not.toBe(args.sessionRoot);
    // T5 (硬要求 6): bootstrap 锚 iknow 自身安装根，与两个项目根都无关 ——
    // 裸树上没有 node_modules，从 cwd 解析 tsx 会崩。
    expect(args.installRoot).toBe(built!.sessionRoots.installRoot);
    expect(args.installRoot).not.toBe(args.sessionRoot);
    // and the manager's parent sandboxRoot is the same tree: the worker
    // envelope's sandboxRoot inherits it (SC8) — same worktree, cwd AND sandbox
    expect(mockState.managerOpts?.sandboxRoot).toBe(wtRoot);
  });

  it("main-repo root (unbound): NO sessionRoot — spawn behavior is today's", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-spawn-root-2"),
      askUser: createNoAskUser(),
      cwd: repoDir,
      workspaceRoot: repoDir,
    });

    expect(built.subagentManager).toBeDefined();
    expect(mockState.spawnFactoryArgs).toHaveLength(1);
    const args = mockState.spawnFactoryArgs[0]!;
    expect(args.sessionRoot).toBeUndefined();
    expect(args.workspaceRoot).toBe(repoDir);
    // 未改绑时身份根与会话根同值 —— 行为与今日一致。
    expect(args.projectIdentityRoot).toBe(repoDir);
    expect(mockState.managerOpts?.sandboxRoot).toBe(repoDir);
  });
});
