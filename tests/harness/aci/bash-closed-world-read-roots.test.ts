/**
 * T4 (plans/closed-world-bash-fence.md) — 消费方接线:installRoot + git 全局
 * 配置读成员进 bash 围栏(前台 + 后台)。
 *
 * ADR-0037 §9.2:
 *   - #4 installRoot:项目自身工具链(node_modules/.bin)的读通道,合同根,
 *     由装配层(registry ← build-engine sessionRoots)喂给 bash 工厂;
 *     前台 fence 与 background spawn 消费同一份 token(D2 同波同一份)。
 *   - #7 git 全局配置(~/.gitconfig + ~/.config/git/config):可选读成员,
 *     单一 source helper(defaultOptionalReadRoots)生成,存在性跳过。
 *
 * 前台链路经 runInSandbox → spawn,与 bash-identity-read-whitelist.test.ts
 * 同款 spawn-mock 策略;后台直驱 defaultBackgroundSpawn(同一 mock 拦截)。
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function makeFakeChild(pid = 47181) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  // 前台路径经 runInSandbox 等子进程退出 —— 异步发 close(code 0) 模拟
  // bwrap 立即成功返回,避免真实 spawn 拖慢/超时。
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

/** home fixture:真实目录 + ~/.gitconfig + ~/.config/git/config 在盘。 */
function makeHomeWithGitConfig(): string {
  const home = makeRealDir("bash-read-roots-home-");
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n  name = t4\n");
  writeFileSync(join(home, ".config", "git", "config"), "[user]\n");
  return home;
}

function roBindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
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

describe("bash closed-world read roots (T4 wiring)", () => {
  it("foreground fence carries --ro-bind <installRoot> when opts.installRoot is threaded", async () => {
    const taskRoot = makeRealDir("bash-read-roots-task-");
    const installRoot = makeRealDir("bash-read-roots-install-");
    const tool = createBashTool(taskRoot, { installRoot });
    const argv = await driveForeground(tool, "echo fg");
    assert.notEqual(
      roBindIndex(argv, installRoot),
      -1,
      `foreground fence must ro-bind installRoot; argv=${JSON.stringify(argv)}`
    );
    // 读白名单成员在可写 cwd bind 之前(bwrap 末挂可写回收语义)。
    const cwdBindIdx = argv.findIndex(
      (arg, i) => arg === "--bind" && argv[i + 1] === taskRoot
    );
    assert.ok(
      roBindIndex(argv, installRoot) < cwdBindIdx,
      "installRoot ro-bind must precede the writable cwd bind"
    );
  });

  it("foreground fence carries the git global config pair as optional members", async () => {
    const taskRoot = makeRealDir("bash-read-roots-task2-");
    const home = makeHomeWithGitConfig();
    const tool = createBashTool(taskRoot, { home });
    const argv = await driveForeground(tool, "echo git");
    assert.notEqual(
      roBindIndex(argv, join(home, ".gitconfig")),
      -1,
      `foreground fence must ro-bind ~/.gitconfig when it exists; argv=${JSON.stringify(argv)}`
    );
    assert.notEqual(
      roBindIndex(argv, join(home, ".config", "git", "config")),
      -1,
      "foreground fence must ro-bind ~/.config/git/config when it exists"
    );
  });

  it("absent installRoot opt → no installRoot ro-bind and no failure (optional at the consumer)", async () => {
    const taskRoot = makeRealDir("bash-read-roots-task3-");
    const tool = createBashTool(taskRoot);
    const argv = await driveForeground(tool, "echo legacy");
    assert.equal(
      roBindIndex(argv, taskRoot),
      -1,
      "without opts.installRoot the fence must not gain a self-referential ro-bind"
    );
  });

  it("background fence consumes the SAME installRoot token as foreground (D2)", async () => {
    const taskRoot = makeRealDir("bash-read-roots-task4-");
    const installRoot = makeRealDir("bash-read-roots-install4-");
    const home = makeHomeWithGitConfig();
    const fgTool = createBashTool(taskRoot, { installRoot, home });
    const fg = await driveForeground(fgTool, "echo parity");
    const bg = await driveBackground({
      command: "echo parity",
      cwd: taskRoot,
      home,
      installRoot,
    });
    assert.notEqual(roBindIndex(bg, installRoot), -1);
    assert.notEqual(roBindIndex(bg, join(home, ".gitconfig")), -1);
    // 前后台对同一 token 的 ro-bind 形态一致(同一份,不漂移)。
    assert.deepEqual(
      roBindIndex(bg, installRoot) >= 0,
      roBindIndex(fg, installRoot) >= 0
    );
    assert.deepEqual(
      roBindIndex(bg, join(home, ".gitconfig")) >= 0,
      roBindIndex(fg, join(home, ".gitconfig")) >= 0
    );
  });

  it("background fence without installRoot/projectIdentityRoot stays constructible (legacy callers)", async () => {
    const taskRoot = makeRealDir("bash-read-roots-task5-");
    const argv = await driveBackground({
      command: "echo legacy",
      cwd: taskRoot,
    });
    assert.notEqual(argv.length, 0);
    assert.equal(argv[0], "--unshare-user-try");
  });
});
