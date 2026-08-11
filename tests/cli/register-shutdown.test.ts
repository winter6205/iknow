/**
 * tests/cli/register-shutdown.test.ts
 *
 * #365 T5:registerShutdown 测试覆盖(surface:"tui" 接线清理的兜底测试面)。
 *
 * 契约(src/cli/runtime.ts:128-160,实测校准):
 *   - registerShutdown(built) 挂 SIGINT / SIGTERM / beforeExit(once) 三个监听器;
 *   - 任意信号触发 → dispose() → built.shutdown?.()(缺席则 no-op);
 *   - shuttingDown 是单一共享守卫:首个 dispose 执行 shutdown 一次,后续任何
 *     dispose(信号 / 主动调用)都是 no-op — 幂等(实测:三信号顺序 emit 后
 *     counter === 1,不是每信号各 1 次);
 *   - 信号链路尾部 process.kill(process.pid, sig) 强杀兜底 — 测试用
 *     process.emit 只同步跑 listener 不真发信号(独立 probe 实测单次 emit
 *     后 kill 在 Linux 异步投递、不重入,进程正常退出)。
 *
 * 信号清理:vitest fork 内 process.listeners 跨 test 不自动清理,故
 * beforeEach / afterEach removeAllListeners 三个信号,避免污染其它测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerShutdown } from "../../src/cli/runtime.ts";
import type { BuiltEngine } from "../../src/cli/runtime.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createLoopEngine } from "../../src/harness/index.ts";

/** 占位 engine(测试只关心 shutdown 路径,engine 本体不被调用)。 */
function makeEngine(): ReturnType<typeof createLoopEngine> {
  return createLoopEngine({} as unknown as LoopEngineDeps);
}

const SIGNALS = ["SIGINT", "SIGTERM", "beforeExit"] as const;

function cleanupSignalListeners(): void {
  for (const sig of SIGNALS) {
    process.removeAllListeners(sig);
  }
}

describe("registerShutdown (#365 T5)", () => {
  beforeEach(() => {
    cleanupSignalListeners();
  });

  afterEach(() => {
    cleanupSignalListeners();
  });

  it("BuiltEngine.shutdown 存在时,SIGINT 触发 dispose → shutdown 计数器 +1", async () => {
    let callCount = 0;
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: makeEngine(),
      shutdown: async () => {
        callCount += 1;
      },
    };

    const { dispose } = registerShutdown(built);

    // vitest 不真发信号到子进程,process.emit 同步跑 listener 即可。
    process.emit("SIGINT");
    // dispose().finally(...) 是微任务链,setImmediate 排空后断言。
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);

    // shuttingDown 单一守卫:首个 dispose 已消费,后续 dispose(信号 / 主动)
    // 均 no-op → 计数保持 1(幂等,实测校准:ticket 原预期 2 与实际不符)。
    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);

    await dispose();
    expect(callCount).toBe(1);

    await dispose();
    expect(callCount).toBe(1);
  });

  it("BuiltEngine.shutdown 缺席时,registerShutdown 不抛 + dispose 也不抛", async () => {
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: makeEngine(),
      // shutdown 字段缺席(#356 T6 契约:ask surface manager 未创建 → 缺席)。
    };

    // registerShutdown 直接调用,若抛则测试失败。
    const { dispose } = registerShutdown(built);

    expect(() => process.emit("SIGINT")).not.toThrow();
    await new Promise((r) => setImmediate(r));

    await expect(dispose()).resolves.toBeUndefined();
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("SIGINT + SIGTERM + beforeExit 三类信号都触发 dispose(surface:tui 模拟)", async () => {
    let callCount = 0;
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: makeEngine(),
      shutdown: async () => {
        callCount += 1;
      },
    };

    registerShutdown(built);

    // 三类信号都挂了监听(接线覆盖:each 1 listener)。
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(process.listenerCount("beforeExit")).toBe(1);

    // 顺序 emit 三类信号,每类信号都走到 dispose 路径。shuttingDown 单一
    // 守卫 → 首个 dispose 执行 shutdown 一次,后续信号 no-op(实测校准:
    // counter === 1,不是 ticket 预期的每信号各 1 次)。
    for (const sig of SIGNALS) {
      process.emit(sig);
      await new Promise((r) => setImmediate(r));
    }
    expect(callCount).toBe(1);

    // beforeExit 监听是 once → emit 消费后计数归零;SIGINT/SIGTERM 常驻。
    expect(process.listenerCount("beforeExit")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });
});
