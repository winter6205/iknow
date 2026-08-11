/**
 * tests/cli/register-shutdown.test.ts
 *
 * #365 T5:registerShutdown 测试覆盖(surface:"tui" 接线清理的兜底测试面)。
 *
 * 契约(src/cli/runtime.ts:128-172,实测校准):
 *   - registerShutdown(built) 挂 SIGINT / SIGTERM / beforeExit(once) 三个监听器;
 *   - 任意信号触发 → dispose() → built.shutdown?.()(缺席则 no-op);
 *   - shuttingDown 是单一共享守卫:首个 dispose 执行 shutdown 一次,后续任何
 *     dispose(信号 / 主动调用)都是 no-op — 幂等(实测:三信号顺序 emit 后
 *     counter === 1,不是每信号各 1 次);
 *   - 参数放宽为结构 `{ readonly shutdown?: () => Promise<void> }`(#365
 *     DRIFT-1):不要求 BuiltEngine / deps / engine / subagentManager 形态,
 *     TUI 入口只透 shutdown 句柄(Gap B)。
 *
 * 信号退出语义(DRIFT-1,真实信号投递实测校准 — #365 review blocker):
 *   - 首次信号:dispose() 完成后 process.kill(process.pid, sig) 重发一次,
 *     让外部处理器(chat-session 的 onSigint 计数器等)有机会强退;
 *   - reKilled 守门:第二次信号落地后 process.exit(code) 直接退出,不再
 *     re-kill — 避免无外部处理器时 unconditional re-kill 与自身 handler
 *     互踢成 microtask 死循环(旧实现 node/bun 真实 SIGINT 挂死,SIGKILL
 *     才退;vitest process.emit 同步路径掩盖了该 bug);
 *   - 单次信号最终退出码:SIGINT → 130,SIGTERM → 143。
 *
 * 测试纪律:进程级信号断言必须走真实子进程 + child.kill,不能用
 * process.emit 假装验证 — emit 只同步跑 listener,不真投递信号,掩盖
 * DRIFT-1 的 re-kill 死循环(旧测试注释"单次 emit 后 kill 在 Linux 异步
 * 投递、不重入"实测为假)。子进程内注册真实 registerShutdown(runtime.ts),
 * ready 就绪后 kill 真实信号;父进程 30s 超时 guard — 挂死即 fail。
 *
 * 副作用隔离:
 *   - fork 内 emit 测试用 vi.spyOn(process, 'kill') 把 re-kill 桩成 no-op,
 *     避免真实 SIGINT 回投到 vitest worker;二次 emit 命中 reKilled 守门会
 *     走 process.exit(code) — 也被桩成 no-op 拦截。真实信号退出码(130/143)
 *     只走 child spawn 路径(下方 3 个 case)验证。
 *   - 子进程内 shutdown 钩子通过文件侧通道写入"dispose-ran"哨兵:
 *     process.exit 不排空 stdio pipe,stderr 在退出前可能丢缓冲;文件
 *     写入 fs.writeFileSync 同步落盘,确定性可读。
 *
 * 信号清理:vitest fork 内 process.listeners 跨 test 不自动清理,故
 * beforeEach / afterEach removeAllListeners 三个信号,避免污染其它测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerShutdown } from "../../src/cli/runtime.ts";
import type { BuiltEngine } from "../../src/cli/runtime.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createLoopEngine } from "../../src/harness/index.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "beforeExit"] as const;

function cleanupSignalListeners(): void {
  for (const sig of SIGNALS) {
    process.removeAllListeners(sig);
  }
}

/**
 * 定位 tsx CLI(worktree 的 node_modules 是空的,依赖从主仓库提升):
 * 从本文件目录逐级向上找第一个含 node_modules/tsx/dist/cli.mjs 的目录
 * (与 tests/cli/trace.test.ts 同款解析)。
 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // 继续向上
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

// 与 tsx -e 的模块解析一致:子进程 cwd = 仓库根,内联脚本用相对 import。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxCli = resolveTsxCli();

/**
 * 真实信号投递子进程:tsx -e 内注册真实 registerShutdown(runtime.ts),
 * ready 就绪后由父进程 kill 真实信号。返回 { code, timedOut, disposeRan }。
 *   - code:子进程退出码(130/143=期望;null=SIGKILL timeout);
 *   - timedOut:true = 父进程 15s guard 触发 → DRIFT-1 旧实现在此挂死被捕获;
 *   - disposeRan:shutdown 钩子是否真跑过(文件侧通道同步写,绕开 process.exit
 *     不排空 stdio pipe 的丢失风险)。
 *
 * 哨兵写入走 child 侧 `import { writeFileSync } from 'node:fs'`(ESM 语法,
 * tsx -e 内 require 不可用 —— 实测 exit 1:ReferenceError: require is not
 * defined),文件名由 SIG_SENTINEL 环境变量注入,不依赖 stdio pipe 排空。
 */
function runSignalChild(
  shutdownStub: string | null,
  signal: NodeJS.Signals,
  sentinelDir: string
): Promise<{
  code: number | null;
  timedOut: boolean;
  disposeRan: boolean;
  stderr: string;
}> {
  const sentinel = join(sentinelDir, "dispose-ran");
  // 通过环境变量把哨兵路径传给子进程,内联脚本从 process.env.SIG_SENTINEL 读。
  // shutdownStub 是 `_shutdown` 声明本体(顶层出现一次,不得重复拼接)。
  const shutdownBody = shutdownStub
    ? `${shutdownStub}\n    registerShutdown({ shutdown: _shutdown });`
    : "registerShutdown({});";
  const script = `
    import { registerShutdown } from './src/cli/runtime.ts';
    import { writeFileSync } from 'node:fs';
    ${shutdownBody}
    console.error('stage: ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, [tsxCli, "-e", script], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SIG_SENTINEL: sentinel },
  });
  let err = "";
  let signalled = false;
  child.stdout.on("data", () => {
    /* 抑制 stdout;只用 stderr 判定 ready */
  });
  child.stderr.on("data", (d) => {
    err += String(d);
    if (err.includes("stage: ready") && !signalled) {
      signalled = true;
      child.kill(signal);
    }
  });
  child.on("error", () => {
    /* exit 事件兜底 resolve */
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: {
      code: number | null;
      timedOut: boolean;
      disposeRan: boolean;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // 30s guard:冷启动 import runtime.ts 图约 4-9s(并发 fork 下更久),
    // 30s 既给足冷启动余量,又能捕获 DRIFT-1 旧实现的无限 re-kill 挂死。
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: null,
        timedOut: true,
        disposeRan: existsSync(sentinel),
        stderr: err,
      });
    }, 30000);
    child.on("exit", (code) => {
      clearTimeout(guard);
      // writeFileSync 在 dispose 里同步落盘,exit 后立即可读。
      finish({
        code,
        timedOut: false,
        disposeRan: existsSync(sentinel),
        stderr: err,
      });
    });
  });
}

describe("registerShutdown (#365 T5)", () => {
  let sentinelDir: string;

  beforeEach(() => {
    cleanupSignalListeners();
    sentinelDir = mkdtempSync(join(tmpdir(), "reg-shut-"));
    // fork 内 emit-based 测试用桩 process.kill 避免 re-kill 真投递 SIGINT
    // 回投到 vitest worker;二次 emit 会触发 reKilled 守门 process.exit(130),
    // 同样被 vitest 拦截报 unhandled rejection → 一并桩成 no-op。真实信号
    // 退出码(130/143)只走下方 child spawn case 验证。
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      // no-op:拦截 reKilled 守门的强杀路径,避免污染 vitest worker。
    });
  });

  afterEach(() => {
    cleanupSignalListeners();
    vi.restoreAllMocks();
    if (sentinelDir) rmSync(sentinelDir, { recursive: true, force: true });
  });

  it("BuiltEngine.shutdown 存在时,信号触发 dispose → shutdown 计数器 +1(幂等)", async () => {
    let callCount = 0;
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      shutdown: async () => {
        callCount += 1;
      },
    };

    const { dispose } = registerShutdown(built);

    // fork 内 process.emit 只同步跑 listener,re-kill 被 process.kill 桩
    // 截掉。真实信号语义走下方 child spawn case。
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
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      // shutdown 字段缺席(#356 T6 契约:ask surface manager 未创建 → 缺席)。
    };

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
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
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

  it("参数放宽(Gap B):TUI 入口只透 shutdown 句柄也能注册", async () => {
    let callCount = 0;
    // 与 src/tui/run.tsx 同形:不传 deps / engine / subagentManager。
    const { dispose } = registerShutdown({
      shutdown: async () => {
        callCount += 1;
      },
    });

    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);
    await dispose();
    expect(callCount).toBe(1);
  });

  it("真实 SIGINT 投递:dispose 完成后二次强杀语义 → 进程以 130 退出(不挂死)", async () => {
    // 真实子进程 + child.kill('SIGINT') —— process.emit 只同步跑 listener,
    // 掩盖 DRIFT-1 的 re-kill 死循环(旧实现 node/bun 真实 SIGINT 挂死)。
    // 单次 SIGINT:首次信号 dispose() → 重发一次 → 二次信号落地 reKilled
    // 守门 → process.exit(130)。实测校准:子进程 cwd = 仓库根,内联脚本用
    // 相对 import 加载真实 registerShutdown(runtime.ts)。
    const r = await runSignalChild(
      "const _shutdown = async () => { writeFileSync(process.env.SIG_SENTINEL, 'ran') }",
      "SIGINT",
      sentinelDir
    );
    expect(r.timedOut).toBe(false);
    expect(r.code, `child stderr: ${r.stderr}`).toBe(130);
    expect(r.disposeRan, `child stderr: ${r.stderr}`).toBe(true);
    expect(readFileSync(join(sentinelDir, "dispose-ran"), "utf8")).toBe("ran");
  }, 90000);

  it("真实 SIGTERM 投递:dispose 完成后二次强杀语义 → 进程以 143 退出(不挂死)", async () => {
    const r = await runSignalChild(
      "const _shutdown = async () => { writeFileSync(process.env.SIG_SENTINEL, 'ran') }",
      "SIGTERM",
      sentinelDir
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(143);
    expect(r.disposeRan).toBe(true);
  }, 90000);

  it("真实 SIGINT 投递 + shutdown 缺席:no-op dispose 后同样二次强杀 → 130", async () => {
    const r = await runSignalChild(null, "SIGINT", sentinelDir);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(130);
    expect(r.disposeRan).toBe(false);
  }, 90000);
});
