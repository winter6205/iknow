/**
 * openBrowser fail-safe tests (robustness of the auto-open feature).
 *
 * Coverage (defensive contract):
 *   - happy path: spawns the correct per-platform command, child unref'd.
 *   - failure path: async spawn 'error' events (EACCES/ENOENT) are swallowed;
 *     openBrowser neither throws nor crashes the process (an unmonitored
 *     'error' once became an unhandled error that took down the CLI).
 *   - failure path: a synchronous spawn throw is caught, not propagated.
 *   - enabled=false → no-op, no spawn.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  openBrowser,
  openCommandForPlatform,
} from "../../src/cli/open-browser.ts";

/** Fake spawn return: a ChildProcess subset (on + unref). */
function fakeChild() {
  const child = new EventEmitter();
  (child as unknown as { unref(): void }).unref = () => {};
  return child as EventEmitter & { unref(): void };
}

// -- platform command resolution -----------------------------------------------

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

// -- happy path ------------------------------------------------------------------

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
    // An 'error' listener is attached (the key guard here: only a listener can swallow the async error).
    assert.equal(child.listenerCount("error") >= 1, true);
  });
});

// -- failure paths ----------------------------------------------------------------

describe("openBrowser — 失败路径", () => {
  it("异步 'error' 事件（EACCES/ENOENT）被吞掉，不 throw、不崩进程", () => {
    const child = fakeChild();
    const fakeSpawn = () => child;
    // Returns the child synchronously; EACCES fires async afterwards (real case: xdg-open missing).
    openBrowser("http://x/", { spawnProcess: fakeSpawn as never });
    const err = Object.assign(new Error("spawn xdg-open EACCES"), {
      errno: -13,
      code: "EACCES",
      syscall: "spawn",
      path: "xdg-open",
    });
    // Without a listener, emit would throw (unhandled); with one it is silently swallowed.
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
