/** @jsxImportSource @opentui/react */
/**
 * Slice D / plan task 7 —— 「打断必须抵达子代理 wait 链」的两条出口的真链路回归：
 *   - SC15：Ctrl+C（无选区 + running-fg）打断前台 `spawn_subagent(wait:true)`；
 *   - SC12：`/quit` 先 abort 当前前台 turn 再收尾，不等子代理 per-task 墙钟
 *     （缺省 7200s）。
 *
 * 已核实的出口链路（R2 票面；本测逐段走到 ground truth）：
 *   app.tsx（Ctrl+C handler / quit() 的 `abortForegroundTurnOnQuit`）
 *   → `aborters.get(id).abort()` → bridge.postMessage({signal}）→ SessionHub
 *   → loop-engine `run(…, signal)` → `executeWaveAndCommit` →
 *   `deps.executor.executeAll(wave, signal, …)` → ACI 中间件（spawn_subagent
 *   声明 `interruptBehavior:"cancel"` → caller signal 透传）→ handler 的
 *   `ctx.signal` → `manager.waitFor(taskId, undefined, ctx.signal)` → signal
 *   abort → reject `SubAgentAbortError`。
 *
 * 为什么用真 ACI registry + 真 manager + 假 spawn（而不是 fake manager）：
 *   命题是「abort 真的抵达 waitFor」。所以除 worker 子进程本身（单测里不真
 *   spawn）之外全用生产实现：装配 `createDefaultAciRegistry` →
 *   `createAciExecutor`（双层 executor 与 build-engine 同形），manager 走
 *   `createSubAgentManager` 的真实 waitFor 轮询 / abort 分支，`spawn` 缝只注入
 *   一个永不 emit 的 fake child。若换 fake manager，waitFor 的 abort 分支就成了
 *   测试自己写的，命题退化为同义反复（本文件的变异探针已实测：把 Ctrl+C 分支的
 *   `controller.abort()` 去掉，SC15 用例转红 —— 非空洞测试）。
 *
 * 深度诚实声明：模型步进是 `createStubModel`（不接真实 LLM），worker 子进程是
 * fake ChildProcess（不真 spawn）。真实模型 e2e 在 `archive/tests-real-llm/`，
 * 本文件不做该层断言。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.js";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { createSubAgentManager } from "../../src/harness/subagent/manager.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/index.js";

const COLS = 80;
const ROWS = 30;

/** 合法最小 env（registry 只消费 web 字段）。 */
const webEnv = { web: { searchUrl: undefined, proxy: undefined } };

/** 永不 emit 的 fake worker（只在 abort / shutdown 时被 kill）。 */
function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 424_242,
    kill: () => true,
    exitCode: null,
  }) as unknown as ChildProcess;
}

/** 轮询直到 cond 为真（stdin 异步解析 + React commit 都有延迟）。 */
async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until timeout: ${label}`);
}

interface WaitingApp {
  readonly setup: TestRendererSetup;
  /** 观测面：manager 真实出口（waitFor 的拒绝）+ spawn 发生。 */
  readonly events: string[];
  readonly waitRejected: () => unknown;
  readonly quitCalls: () => number;
  readonly typeText: (text: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * 挂起一个「模型调 spawn_subagent(wait:true) → handler 永久阻塞在 waitFor」
 * 的 TUI：除 worker 子进程外全生产装配。
 */
async function mountWaitingApp(): Promise<WaitingApp> {
  const events: string[] = [];
  let waitRejected: unknown;
  let quitCalls = 0;
  const manager = createSubAgentManager({
    spawn: () => {
      events.push("spawn");
      return makeFakeChild();
    },
  });
  // 观测 manager 的真实出口：abort 抵达时 waitFor 必须以 SubAgentAbortError
  // 拒绝 —— 这是 spawn_subagent handler 归一 cancelled 的上游事实。
  const realWaitFor = manager.waitFor.bind(manager);
  const observedManager: typeof manager = {
    ...manager,
    waitFor: (taskId, timeoutMs, signal) => {
      const pending = realWaitFor(taskId, timeoutMs, signal);
      pending.catch((err: unknown) => {
        events.push("waitFor-rejected");
        waitRejected = err;
      });
      return pending;
    },
  };

  const reg = createDefaultAciRegistry({
    env: webEnv as never,
    sandboxRoot: process.cwd(),
    subagentManager: observedManager,
  });
  const deps: LoopEngineDeps = {
    adapter: createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "spawn-1",
              name: "spawn_subagent",
              input: { task: "sleep forever", wait: true },
            },
          ],
        }),
      ],
    }),
    executor: createAciExecutor({
      inner: createExecutor(reg.inner),
      catalog: reg.catalog,
      askUser: async () => true,
    }),
    registry: reg.inner,
    maxTurns: 5,
  };

  const dataDir = mkdtempSync(join(tmpdir(), "iknow-wait-cancel-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps,
    inflight: createInflightRegistry(),
    subagentManager: observedManager,
  });
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      onQuit={() => {
        quitCalls += 1;
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  await setup.waitForVisualIdle();

  /** 逐键 60ms：mockInput 走 stdin 异步解析，连发会丢键（实测 "hi" 连发 +
   *  立刻 Enter → 输入未落地，turn 不启动、spawn 永不发生）。 */
  const typeText = async (text: string): Promise<void> => {
    for (const ch of text) {
      setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
    }
    setup.mockInput.pressEnter();
  };

  // 发一条消息 → 等 spawn 发生 → 等会话真的进入 running-fg。后者是必须的：
  // Ctrl+C / quit 的 abort 只在 running-fg 生效，与 React commit 竞态时按键
  // 会落进 idle 分支，abort 永不发出（测试变成空洞绿灯）。
  await typeText("hi");
  await until(() => events.includes("spawn"), 8000, "spawn 未发生");
  await until(
    () => /运行中/.test(setup.captureCharFrame()),
    8000,
    "会话未进入 running-fg"
  );

  return {
    setup,
    events,
    waitRejected: () => waitRejected,
    quitCalls: () => quitCalls,
    typeText,
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      await manager.shutdown();
    },
  };
}

describe("打断抵达子代理 wait 链（SC15 Ctrl+C / SC12 /quit）", () => {
  test("SC15: running-fg + Ctrl+C → waitFor 以 SubAgentAbortError 拒绝", async () => {
    const app = await mountWaitingApp();
    try {
      // 无选区 + running-fg → Ctrl+C 走 canInterrupt 分支 abort 该会话。
      app.setup.mockInput.pressCtrlC();
      await until(
        () => app.events.includes("waitFor-rejected"),
        8000,
        "waitFor 未收到 abort"
      );

      expect(app.waitRejected()).toBeInstanceOf(Error);
      expect((app.waitRejected() as Error).name).toBe("SubAgentAbortError");

      // 屏上收尾：abort 让整回合以 cancelled 收敛，app 出打断 notice
      // （文案二选一取决于 delta 是否为 0，此处只钉「已打断」这一事实面）。
      await until(
        () => /已打断/.test(app.setup.captureCharFrame()),
        8000,
        "打断 notice 未出现"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("SC12: /quit → waitFor 以 SubAgentAbortError 拒绝，且退出不挂起", async () => {
    const app = await mountWaitingApp();
    try {
      // 无后台会话 → /quit 不需要二次确认，直接走收尾。
      await app.typeText("/quit");
      await until(
        () => app.events.includes("waitFor-rejected"),
        8000,
        "/quit 未 abort 前台 wait"
      );
      // 退出真的完成（onQuit 被调）—— 不 abort 时这里要等 7200s 墙钟，
      // 8s 窗口即失败，正是 SC12 的命题。
      await until(() => app.quitCalls() === 1, 8000, "/quit 未完成收尾");

      expect((app.waitRejected() as Error).name).toBe("SubAgentAbortError");
      expect(app.quitCalls()).toBe(1);
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
