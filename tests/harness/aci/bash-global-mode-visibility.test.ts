/**
 * ADR-0092 — global-mode visibility wiring (foreground + background).
 *
 * Replaces `bash-closed-world-read-roots.test.ts`: the closed-world read
 * whitelist (per-root `--ro-bind` of installRoot / global git config) retired
 * with global mode — `--bind / /` already exposes real host paths, so no
 * per-root read channel is needed. This file authenticates what remains true:
 *   - host root `--bind / /` is the same on both fg and bg sides;
 *   - read-only system-prefix rebinding remains (readable, writes denied);
 *   - no per-root `--ro-bind <home|installRoot>` whitelist emission anymore
 *     (that channel no longer exists to authenticate); absent options must not
 *     break construction.
 *
 * Foreground goes through the spawn-mock interception; background drives
 * defaultBackgroundSpawn directly (same mock).
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

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
const { defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const { READ_ONLY_SYSTEM_PATHS, OPTIONAL_HOST_RO_PREFIXES } =
  await import("../../../src/harness/sandbox/fs-policy.ts");

function makeFakeChild(pid = 47181) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  // The foreground path waits for child exit inside runInSandbox — emit
  // close(code 0) asynchronously to mimic bwrap returning instantly, so the
  // fake spawn never slows or times out the test.
  queueMicrotask(() => {
    child.emit("close", 0);
  });
  return child;
}

const REAL_DIRS: string[] = [];
function makeRealDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  REAL_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of REAL_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});
afterEach(() => {
  spawnMock.mockReset();
});

function roBindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function hasHostRootBind(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
  );
}

async function driveForeground(
  tool: ReturnType<typeof createBashTool>,
  command: string
): Promise<readonly string[]> {
  spawnMock.mockClear();
  await tool.handler({ command });
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}

async function driveBackground(
  req: Parameters<typeof defaultBackgroundSpawn>[0]
): Promise<readonly string[]> {
  spawnMock.mockClear();
  await defaultBackgroundSpawn(req);
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}

describe("bash global-mode visibility (ADR-0092 wiring)", () => {
  it("foreground fence binds the host root and never emits a per-root read whitelist", async () => {
    const taskRoot = makeRealDir("bash-global-task-");
    const tool = createBashTool(taskRoot);
    const argv = await driveForeground(tool, "echo fg");
    assert.ok(
      hasHostRootBind(argv),
      `foreground fence must --bind / /; argv=${JSON.stringify(argv)}`
    );
    // Only fixed ro-binds of system prefixes (plus optional host prefixes) are
    // allowed; the closed-world per-root read whitelist (installRoot / git
    // config) retired with global mode.
    const allowedRoBindTargets = new Set<string>([
      ...READ_ONLY_SYSTEM_PATHS,
      ...OPTIONAL_HOST_RO_PREFIXES,
    ]);
    const strayRoBind = argv.find(
      (arg, i) =>
        arg === "--ro-bind" &&
        !allowedRoBindTargets.has(argv[i + 1] ?? "") &&
        argv[i + 1] !== taskRoot
    );
    assert.equal(
      strayRoBind,
      undefined,
      "no per-root installRoot / home read whitelist in global mode"
    );
    assert.equal(
      argv.some((arg, i) => arg === "--bind" && argv[i + 1] === taskRoot),
      false,
      "retired: no per-root writable cwd bind in global mode"
    );
  });

  it("system prefixes stay read-only (visible but not writable)", async () => {
    const taskRoot = makeRealDir("bash-global-task2-");
    const tool = createBashTool(taskRoot);
    const argv = await driveForeground(tool, "echo ro");
    for (const path of READ_ONLY_SYSTEM_PATHS) {
      assert.notEqual(
        roBindIndex(argv, path),
        -1,
        `system prefix ${path} must stay ro-bound`
      );
    }
  });

  it("background fence consumes the SAME host-root token as foreground (D2)", async () => {
    const taskRoot = makeRealDir("bash-global-task3-");
    const fg = await driveForeground(createBashTool(taskRoot), "echo parity");
    const bg = await driveBackground({
      command: "echo parity",
      cwd: taskRoot,
    });
    assert.ok(hasHostRootBind(fg), "fg must --bind / /");
    assert.ok(hasHostRootBind(bg), "bg must --bind / /");
  });

  it("background fence without installRoot stays constructible (legacy callers)", async () => {
    const taskRoot = makeRealDir("bash-global-task4-");
    const argv = await driveBackground({
      command: "echo legacy",
      cwd: taskRoot,
    });
    assert.notEqual(argv.length, 0);
    assert.equal(argv[0], "--unshare-user-try");
  });
});
