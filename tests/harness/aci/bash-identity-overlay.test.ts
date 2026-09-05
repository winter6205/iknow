/**
 * #891 T2 → T3 闭世界改写(ADR-0037 §9.3 将 overlay 条款 superseded)。
 *
 * 合同(闭世界形态):
 * 1. 前台(foreground fence)与后台(handleBackground → manager.spawn →
 *    defaultBackgroundSpawn)消费**同一**身份根 token(D2 同波同一份;
 *    CONTEXT 沙箱纪律:前后台共用围栏)。
 * 2. 未改绑波次(活 taskRoot == 身份根)不传身份根,argv 不含身份
 *    `--ro-bind` token。
 * 3. 改绑波次 argv 含 `--ro-bind <identity> <identity>`(读白名单成员),
 *    位于可写 cwd bind 之前;writable home 打底 token 消失——不存在可写
 *    祖先可被覆盖,身份根不再是 overlay 而是读成员。
 *
 * 后台链路沿用 bash-live-task-root.test.ts 的 handler+spawn-mock 策略
 * （生产热路径 end-to-end）；前台链路用真实 tmpdir 直驱 handler，读
 * runInSandbox 之前的 fence 构造不可行，故前台断言走 spawn mock 的同一条
 * 通道（foreground 也经 runInSandbox → spawn）。
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { createBashTool } =
  await import("../../../src/harness/aci/tools/bash.ts");
const { createBackgroundTaskManager, defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const sessionRootsModule =
  await import("../../../src/harness/session-roots.ts");
const { createLiveTaskRoot } = sessionRootsModule;

function makeFakeChild(pid = 47171) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  // 前台路径经 runInSandbox 等子进程退出 —— 异步发 close(code 0) 模拟
  // bwrap 立即成功返回，避免真实 spawn 拖慢/超时。
  queueMicrotask(() => {
    child.emit("close", 0);
  });
  return child;
}

function makeManager() {
  return createBackgroundTaskManager({
    tasksDir: "/tmp/tasks",
    spawn: defaultBackgroundSpawn,
  });
}

/** 复现 #891 泄漏形状：home 含主仓，主仓含 task worktree。 */
function makeLeakShape() {
  const root = mkdtempSync(join(tmpdir(), "bash-ovl-891-"));
  const home = join(root, "home");
  const repo = join(home, "projects", "iknow");
  const taskRoot = join(repo, ".iknow", "worktrees", "conv-891");
  mkdirSync(taskRoot, { recursive: true });
  return { root, home, repo, taskRoot };
}

function identityBindIndex(argv: readonly string[], identity: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" &&
      argv[i + 1] === identity &&
      argv[i + 2] === identity
  );
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});

afterEach(() => {
  spawnMock.mockReset();
});

describe("bash #891 T2: identity-root overlay wiring", () => {
  it("unbound wave (taskRoot == identity) → no identity ro-bind token (V1 parity)", async () => {
    const dirs = makeLeakShape();
    try {
      // 未改绑：活 taskRoot = sandboxRoot = 身份根本身（cwd 即主仓），此时
      // 无需 overlay —— handler 按 waveRoot === identity 判定不传。
      const tool = createBashTool(dirs.repo, {
        backgroundManager: makeManager(),
        home: dirs.home,
        liveTaskRoot: createLiveTaskRoot(dirs.repo),
        projectIdentityRoot: dirs.repo,
      });
      const argv = await driveForeground(tool, "echo unbound");
      assert.equal(
        identityBindIndex(argv, dirs.repo),
        -1,
        `unbound wave must not carry the identity ro-bind; argv=${JSON.stringify(argv)}`
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("rebound wave → foreground fence carries identity ro-bind before the writable cwd bind (closed world)", async () => {
    const dirs = makeLeakShape();
    try {
      const tool = createBashTool(dirs.taskRoot, {
        backgroundManager: makeManager(),
        home: dirs.home,
        liveTaskRoot: createLiveTaskRoot(dirs.taskRoot),
        projectIdentityRoot: dirs.repo,
      });
      const argv = await driveForeground(tool, "echo rebound");
      const identityIdx = identityBindIndex(argv, dirs.repo);
      assert.notEqual(
        identityIdx,
        -1,
        "rebound wave must carry identity ro-bind"
      );
      // 闭世界:writable home bind 消失,身份根降级为读白名单成员。
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--bind" && argv[i + 1] === dirs.home
        ),
        -1,
        "writable home bind must be gone (closed world)"
      );
      const cwdBindIdx = argv.findIndex(
        (arg, i) => arg === "--bind" && argv[i + 1] === dirs.taskRoot
      );
      assert.notEqual(cwdBindIdx, -1);
      assert.ok(
        identityIdx < cwdBindIdx,
        "identity ro-bind (read member) must precede the writable cwd bind reclaim"
      );
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("background path consumes the SAME overlay token as foreground (D2)", async () => {
    const dirs = makeLeakShape();
    try {
      const tool = createBashTool(dirs.taskRoot, {
        backgroundManager: makeManager(),
        home: dirs.home,
        liveTaskRoot: createLiveTaskRoot(dirs.taskRoot),
        projectIdentityRoot: dirs.repo,
      });
      spawnMock.mockClear();
      await tool.handler({ command: "echo bg", background: true });
      const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
      const argv = (call?.[1] as readonly string[]) ?? [];
      const identityIdx = identityBindIndex(argv, dirs.repo);
      assert.notEqual(
        identityIdx,
        -1,
        `background fence must carry identity ro-bind; argv=${JSON.stringify(argv)}`
      );
      assert.equal(
        argv.findIndex(
          (arg, i) => arg === "--bind" && argv[i + 1] === dirs.home
        ),
        -1,
        "background fence must not carry a writable home bind (closed world)"
      );
      const cwdBindIdx = argv.findIndex(
        (arg, i) => arg === "--bind" && argv[i + 1] === dirs.taskRoot
      );
      assert.notEqual(cwdBindIdx, -1);
      assert.ok(identityIdx < cwdBindIdx);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});

/** 前台驱动：直接调 handler（非 background），从 spawn mock 读 fence argv。 */
async function driveForeground(
  tool: ReturnType<typeof createBashTool>,
  command: string
): Promise<readonly string[]> {
  spawnMock.mockClear();
  await tool.handler({ command });
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}
