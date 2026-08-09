/**
 * openBrowser fail-safe 测试（T7 自动 open 的健壮性）。
 *
 * 覆盖（S2 defensive contract）：
 *   - 正常路径：按平台 spawn 正确命令，child unref。
 *   - 失败路径：spawn 异步 'error' 事件（EACCES/ENOENT）被吞掉，openBrowser
 *     不 throw 也不崩进程（曾因未监听 'error' 变成 unhandled error 带崩 CLI）。
 *   - 失败路径：spawn 同步 throw 被 catch，不向上传播。
 *   - enabled=false → no-op 不 spawn。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  openBrowser,
  openCommandForPlatform,
} from "../../src/cli/open-browser.ts";

/** 模拟 spawn 返回值：ChildProcess 子集（on + unref）。 */
function fakeChild() {
  const child = new EventEmitter();
  (child as unknown as { unref(): void }).unref = () => {};
  return child as EventEmitter & { unref(): void };
}

// -- 平台命令解析 --------------------------------------------------------------

describe("openCommandForPlatform", () => {
  it("darwin → open", () => {
    assert.deepEqual(openCommandForPlatform("darwin"), {
      cmd: "open",
      args: [],
    });
  });
  it("win32 → cmd /c start", () => {
    assert.deepEqual(openCommandForPlatform("win32"), {
      cmd: "cmd",
      args: ["/c", "start", ""],
    });
  });
  it("linux → xdg-open", () => {
    assert.deepEqual(openCommandForPlatform("linux"), {
      cmd: "xdg-open",
      args: [],
    });
  });
});

// -- 正常路径 ------------------------------------------------------------------

describe("openBrowser — 正常路径", () => {
  it("spawns 平台命令 + url，并 unref child", () => {
    let spawned: { cmd: string; args: string[]; opts: unknown } | undefined;
    let unrefCalled = false;
    const child = fakeChild();
    child.unref = () => {
      unrefCalled = true;
    };
    const fakeSpawn = (cmd: string, args: string[], opts: unknown) => {
      spawned = { cmd, args, opts };
      return child;
    };

    openBrowser("http://x/", { spawnProcess: fakeSpawn as never });

    assert.equal(spawned?.cmd, "xdg-open");
    assert.deepEqual(spawned?.args, ["http://x/"]);
    assert.equal(unrefCalled, true);
    // 挂上了 'error' 监听（本用例的关键守卫：监听存在才能吞掉异步错误）。
    assert.equal(child.listenerCount("error") >= 1, true);
  });
});

// -- 失败路径 ------------------------------------------------------------------

describe("openBrowser — 失败路径", () => {
  it("异步 'error' 事件（EACCES/ENOENT）被吞掉，不 throw、不崩进程", () => {
    const child = fakeChild();
    const fakeSpawn = () => child;
    // 同步返回 child；随后异步发射 EACCES（真实场景：找不到 xdg-open）。
    openBrowser("http://x/", { spawnProcess: fakeSpawn as never });
    const err = Object.assign(new Error("spawn xdg-open EACCES"), {
      errno: -13,
      code: "EACCES",
      syscall: "spawn",
      path: "xdg-open",
    });
    // 若 error 未被监听，emit 会 throw（unhandled）；监听后静默吞掉。
    assert.doesNotThrow(() => child.emit("error", err));
  });

  it("同步 throw（spawn 抛错）被 catch，不向上传播", () => {
    const fakeSpawn = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() =>
      openBrowser("http://x/", { spawnProcess: fakeSpawn as never })
    );
  });

  it("enabled=false → no-op，不 spawn", () => {
    let called = false;
    const fakeSpawn = () => {
      called = true;
      return fakeChild();
    };
    openBrowser("http://x/", {
      spawnProcess: fakeSpawn as never,
      enabled: false,
    });
    assert.equal(called, false);
  });
});
