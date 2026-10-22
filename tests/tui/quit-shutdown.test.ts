/**
 * Structural and contract tests for the per-TUI process shutdown coordinator.
 * The full runTui path needs a renderer + runtime bundle that cannot be
 * injected under bun test, so pin the owner cleanup and shared exit wiring.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTuiShutdownCoordinator,
  scheduleTuiExitWatchdog,
} from "../../src/tui/shutdown.js";

const src = readFileSync(
  join(import.meta.dir, "..", "..", "src", "tui", "run.tsx"),
  "utf8"
);

describe("TUI 进程退出协调", () => {
  it("所有 exit path 都进入 owner shutdown coordinator", () => {
    expect(src.includes("const shutdownExtensions")).toBe(true);
    expect(src.includes("shutdownCoordinator.begin(")).toBe(true);
    expect(
      src.includes("const shutdown = shutdownExtensions(inflightTurns)")
    ).toBe(true);
    expect(src.includes("await shutdownExtensions()")).toBe(true);
    expect(src.includes("const hubRef")).toBe(true);
    expect(src.includes("hubRef.current?.shutdown()")).toBe(true);
    expect(src.includes("hubRef.current = bridge.hub")).toBe(true);
  });

  it("信号路径复用同一个 shutdownExtensions promise", () => {
    const combinedShutdown = src.slice(
      src.indexOf("const combinedShutdown = async"),
      src.indexOf("registerShutdown({ shutdown: combinedShutdown })")
    );
    expect(combinedShutdown).toContain(
      "const shutdown = shutdownExtensions();"
    );
    expect(combinedShutdown.indexOf("shutdownExtensions();")).toBeLessThan(
      combinedShutdown.indexOf("teardownTerminal();")
    );
    expect(combinedShutdown.indexOf("teardownTerminal();")).toBeLessThan(
      combinedShutdown.indexOf("endStderrGate();")
    );
    expect(combinedShutdown).toContain("tuiShutdownStatus(report);");
  });

  it("确认退出时先启动所有 owner 清理，再等待各会话的在途轮次", async () => {
    const events: string[] = [];
    const waitForTurn = deferred<void>();
    const cleanup = [
      {
        name: "initial engine",
        stop: () => {
          events.push("initial-started");
          return Promise.resolve().then(() => {
            events.push("initial-finished");
          });
        },
      },
      {
        name: "rebuilt engine",
        stop: () => {
          events.push("rebuilt-started");
          return Promise.resolve().then(() => {
            events.push("rebuilt-finished");
          });
        },
      },
    ];
    const shutdown = createTuiShutdownCoordinator(1000);
    const reportPromise = shutdown.begin(cleanup, [
      waitForTurn.promise.then(() => events.push("turn-wait-finished")),
    ]);

    expect(events).toEqual(["initial-started", "rebuilt-started"]);
    expect(
      shutdown.begin(cleanup, [waitForTurn.promise.then(() => undefined)])
    ).toBe(reportPromise);
    await Promise.resolve();
    expect(events).toContain("initial-finished");
    expect(events).toContain("rebuilt-finished");
    expect(events).not.toContain("turn-wait-finished");

    waitForTurn.resolve();
    const report = await reportPromise;
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.pendingOperations).toEqual([]);
    expect(events.filter((event) => event === "initial-started")).toHaveLength(
      1
    );
  });

  it("有界等待到期时报告尚未确认的 owner，不把超时写成成功", async () => {
    const stuck = deferred<void>();
    const shutdown = createTuiShutdownCoordinator(20);
    const report = await shutdown.begin(
      [
        { name: "remote seat", stop: () => stuck.promise },
        { name: "session hub", stop: async () => undefined },
      ],
      []
    );

    expect(report.timedOut).toBe(true);
    expect(report.cleanupConfirmed).toBe(false);
    expect(report.pendingOperations).toEqual(["remote seat"]);
    stuck.resolve();
  });

  it("空 owner 列表可确认完成，重复 begin 共用同一轮结果", async () => {
    const shutdown = createTuiShutdownCoordinator(1000);
    const result = shutdown.begin([]);
    expect(shutdown.begin([{ name: "late", stop: () => undefined }])).toBe(
      result
    );
    await expect(result).resolves.toEqual({
      cleanupConfirmed: true,
      timedOut: false,
      pendingOperations: [],
      failedOperations: [],
    });
  });

  it("owner 同步重入 begin 时仍返回已锁存的退出结果", async () => {
    const shutdown = createTuiShutdownCoordinator(1000);
    let nested: Promise<unknown> | undefined;
    const first = shutdown.begin([
      {
        name: "reentrant owner",
        stop: () => {
          nested = shutdown.begin([]);
        },
      },
    ]);

    expect(nested).toBe(first);
    await expect(first).resolves.toEqual({
      cleanupConfirmed: true,
      timedOut: false,
      pendingOperations: [],
      failedOperations: [],
    });
  });

  it("清理同步抛出或异步拒绝时按 owner 实例报告失败，不互相覆盖", async () => {
    const shutdown = createTuiShutdownCoordinator(1000);
    const report = await shutdown.begin([
      {
        name: "duplicate owner label",
        stop: () => {
          throw new Error("sync cleanup failure");
        },
      },
      {
        name: "duplicate owner label",
        stop: () => Promise.reject(new Error("async cleanup failure")),
      },
      { name: "duplicate owner label", stop: async () => undefined },
    ]);

    expect(report.cleanupConfirmed).toBe(false);
    expect(report.failedOperations).toEqual([
      "duplicate owner label",
      "duplicate owner label",
    ]);
  });

  it("clean cleanup 报告后仍用 unref watchdog 收割残留 event-loop handle", async () => {
    const keepProcessAlive = setInterval(() => undefined, 1000);
    const watchdogEvents: string[] = [];
    try {
      const timer = scheduleTuiExitWatchdog(
        {
          cleanupConfirmed: true,
          timedOut: false,
          pendingOperations: [],
          failedOperations: [],
        },
        {
          delayMs: 5,
          onProcessStillAlive: () => watchdogEvents.push("residual handles"),
          forceExit: (code) => watchdogEvents.push(`exit ${code}`),
        }
      );

      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
      await delay(15);
      expect(watchdogEvents).toEqual(["residual handles", "exit 1"]);
    } finally {
      clearInterval(keepProcessAlive);
    }
  });

  it("拒绝非有限或越界的 shutdown deadline", () => {
    expect(() => createTuiShutdownCoordinator(0)).toThrow(RangeError);
    expect(() =>
      createTuiShutdownCoordinator(Number.POSITIVE_INFINITY)
    ).toThrow(RangeError);
    expect(() => createTuiShutdownCoordinator(60_001)).toThrow(RangeError);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
