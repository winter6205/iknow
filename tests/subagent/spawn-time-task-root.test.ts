/**
 * T8 (plans/worktree-live-task-root.md §6 T8 / §5 D6) — subagent spawn-time
 * root resolution.
 *
 * Acceptance (plan §6 T8 / §5 D6 + ADR-0040):
 *   1. Subagent inherits parent's `taskRoot` **at spawn time**, not at build
 *      time. `createDefaultSubAgentSpawn({ sessionRoot: getter })` reads the
 *      getter each time the spawn closure fires.
 *   2. SubAgentManager's parent-sandbox-root bound check uses the live cell
 *      as upper bound -- otherwise it would reject subroots inside a fresh
 *      rebound tree (the legacy binding to `workspaceRoot` from build-time
 *      is exactly what T8 retires).
 *   3. Before any rebind: behavior byte-identical to today (manager falls
 *      back to `process.cwd()` upper bound; spawn closure no sessionRoot).
 *
 * ADR-0040: subagent = parent session's executor arm. The parent rebinds
 * its `taskRoot` and the subagent inherits that root; the subagent does NOT
 * trigger a second tree or a second provision.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
  type LiveTaskRoot,
} from "../../src/harness/session-roots.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import {
  createSubAgentManager,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { SubAgentSandboxRootError } from "../../src/harness/errors.ts";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

// ── fake ChildProcess 工厂 ────────────────────────────────────────────────────

function makeFakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 60001,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as EventEmitter & {
    readonly stdin: PassThrough;
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly pid: number;
    readonly kill: ReturnType<typeof vi.fn>;
    readonly exitCode: number | null;
  };
}

// ── manager 捕获 spawn ──────────────────────────────────────────────────────

interface CapturedSpawn {
  readonly def: SubAgentDefinition;
  readonly taskId: string;
  readonly payload: WorkerEnvelope;
}

function makeManagerCapturingSpawn(opts: {
  readonly parentSandboxRoot?: string;
  readonly sandboxRootCell?: () => string;
}): {
  readonly manager: SubAgentManager;
  readonly calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      calls.push({ def, taskId, payload });
      return child as unknown as ChildProcess;
    },
    ...(opts.parentSandboxRoot !== undefined
      ? { sandboxRoot: opts.parentSandboxRoot }
      : {}),
    ...(opts.sandboxRootCell !== undefined
      ? { sandboxRootCell: opts.sandboxRootCell }
      : {}),
  });
  return { manager, calls };
}

function captureSpawnOpts(call: readonly unknown[]): {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: Record<string, unknown>;
} {
  const cmd = call[0] as string;
  const args = (call[1] as readonly string[]) ?? [];
  const opts = (call[2] as Record<string, unknown>) ?? {};
  return { cmd, args, opts };
}

// ── 临时目录管理 ──────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});

// ── 1. sessionRoot 在 spawn 闭包内读活根 ─────────────────────────────────────

describe("createDefaultSubAgentSpawn sessionRoot read at spawn time", () => {
  it("sessionRoot = getter → spawn closure reads cell current value (rebind updates cwd)", () => {
    // build-engine closure-captured `() => liveTaskRoot.read()`;
    // 两次 spawn 之间翻 cell,第二次 spawn 必然看到新 cwd。
    const initialRoot = freshDir("iknow-sub-live-initial-");
    const reboundRoot = freshDir("iknow-sub-live-rebound-");
    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);

    const spawn = createDefaultSubAgentSpawn({
      sessionRoot: () => cell.read(),
    });

    // 第一次 spawn — cell 还是 initialRoot
    spawn({ task: "pre" }, "task-pre", {
      task: "pre",
      sandboxRoot: initialRoot,
    });
    const first = captureSpawnOpts(
      spawnMock.mock.calls[0] as readonly unknown[]
    );
    expect(first.opts.cwd).toBe(initialRoot);

    // rebind
    writeLiveTaskRoot(cell, reboundRoot);

    // 第二次 spawn — cell 已是 reboundRoot,closure 重读。
    spawn({ task: "post" }, "task-post", {
      task: "post",
      sandboxRoot: reboundRoot,
    });
    const second = captureSpawnOpts(
      spawnMock.mock.calls[1] as readonly unknown[]
    );
    expect(second.opts.cwd).toBe(reboundRoot);
  });

  it("sessionRoot = string → legacy parity (frozen value, byte-stable)", () => {
    const cwd = freshDir("iknow-sub-live-frozen-");
    const spawn = createDefaultSubAgentSpawn({
      sessionRoot: cwd,
    });
    spawn({ task: "x" }, "task-x", { task: "x", sandboxRoot: cwd });
    const first = captureSpawnOpts(
      spawnMock.mock.calls[0] as readonly unknown[]
    );
    expect(first.opts.cwd).toBe(cwd);
  });

  it("sessionRoot undefined → no cwd option (legacy parity with unbound sessions)", () => {
    const spawn = createDefaultSubAgentSpawn({});
    spawn({ task: "x" }, "task-x", { task: "x", sandboxRoot: "/tmp" });
    const first = captureSpawnOpts(
      spawnMock.mock.calls[0] as readonly unknown[]
    );
    expect("cwd" in first.opts).toBe(false);
  });
});

// ── 2. manager parent sandboxRoot 走活根 ────────────────────────────────────

describe("SubAgentManager parent sandboxRoot upper-bound uses live cell", () => {
  it("sandboxRootCell getter — after rebind, def in OLD root is rejected", () => {
    // T8 (D6) hard acceptance:
    // parentSandboxRoot 由 sandboxRootCell getter 派生。rebind 后,旧根里的
    // def.sandboxRoot 现在已落在新根之外,应被 typed 拒绝 —— 否则会误放
    // 工作域扩大(子代理工具写到旧 tree)。
    const oldRoot = freshDir("iknow-sub-mgr-old-");
    const newRoot = freshDir("iknow-sub-mgr-new-");
    const cell: LiveTaskRoot = createLiveTaskRoot(oldRoot);

    const { manager, calls } = makeManagerCapturingSpawn({
      sandboxRootCell: () => cell.read(),
    });

    // rebind 到 newRoot。
    writeLiveTaskRoot(cell, newRoot);

    // 旧根内的 def.sandboxRoot = oldRoot 本身 ——
    // 父上界已切到 newRoot,relative(newRoot, oldRoot) 以 ".." 起头 → typed 拒绝。
    expect(() => manager.spawn({ sandboxRoot: oldRoot })).toThrow(
      SubAgentSandboxRootError
    );
    expect(calls).toHaveLength(0);

    // 新根内的子路径必须通过。
    const sub = join(newRoot, "work");
    mkdirSync(sub, { recursive: true });
    manager.spawn({ sandboxRoot: sub });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.sandboxRoot).toBe(realpathSync(sub));
  });

  it("sandboxRootCell getter — before rebind, legacy behavior (parent = initial root)", () => {
    // 未翻 cell 时,manager 的 sandboxRootCell 表现与冻结值一致。
    const parent = freshDir("iknow-sub-mgr-parent-");
    const cell: LiveTaskRoot = createLiveTaskRoot(parent);
    const { manager, calls } = makeManagerCapturingSpawn({
      sandboxRootCell: () => cell.read(),
    });

    // 子路径合法 ——
    const sub = join(parent, "work");
    mkdirSync(sub, { recursive: true });
    manager.spawn({ sandboxRoot: sub });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.sandboxRoot).toBe(realpathSync(sub));

    // 父根外拒绝 ——
    expect(() => manager.spawn({ sandboxRoot: "/etc" })).toThrow(
      SubAgentSandboxRootError
    );
    expect(calls).toHaveLength(1);
  });
});

// ── 3. 父未 rebind 时:行为与今日一致 ────────────────────────────────────────

describe("SubAgentManager / SubAgentSpawn before rebind: legacy parity", () => {
  it("manager opts.sandboxRoot: 传 string 时行为与今日一致", () => {
    const parent = freshDir("iknow-sub-live-parent-");
    const sub = join(parent, "work");
    mkdirSync(sub, { recursive: true });

    const { manager, calls } = makeManagerCapturingSpawn({
      parentSandboxRoot: parent,
    });
    manager.spawn({ sandboxRoot: sub });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.sandboxRoot).toBe(realpathSync(sub));
  });

  it("manager 既无 sandboxRoot 也无 sandboxRootCell → fallback process.cwd()", () => {
    // 兼容既有 manager.test.ts 的 makeHarness(不传 sandboxRoot)。
    const { manager, calls } = makeManagerCapturingSpawn({});
    manager.spawn({});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.sandboxRoot).toBe(realpathSync(process.cwd()));
  });

  it("createDefaultSubAgentSpawn 无 sessionRoot → no cwd option (byte-stable to today)", () => {
    const spawn = createDefaultSubAgentSpawn({});
    spawn({ task: "x" }, "task-x", { task: "x", sandboxRoot: "/tmp" });
    const first = captureSpawnOpts(
      spawnMock.mock.calls[0] as readonly unknown[]
    );
    expect("cwd" in first.opts).toBe(false);
  });
});
