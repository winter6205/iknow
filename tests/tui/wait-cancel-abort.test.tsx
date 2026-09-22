/** @jsxImportSource @opentui/react */
/**
 * Real-wiring regression for the two exits of "interrupt must reach the
 * subagent wait chain":
 *   - Esc (running-fg) interrupts a foreground `spawn_subagent(wait:true)`
 *     (interrupt key migrated from Ctrl+C to Esc);
 *   - `/quit` aborts the current foreground turn first, then wraps up,
 *     without waiting for the subagent per-task wall clock (default 7200s).
 *
 * Verified exit chain (this test walks every segment to ground truth):
 *   app.tsx (Esc handler / quit()'s `abortForegroundTurnOnQuit`)
 *   → `aborters.get(id).abort()` → bridge.postMessage({signal}) → SessionHub
 *   → loop-engine `run(…, signal)` → `executeWaveAndCommit` →
 *   `deps.executor.executeAll(wave, signal, …)` → ACI middleware
 *   (spawn_subagent declares `interruptBehavior:"cancel"` → caller signal
 *   passes through) → handler's `ctx.signal` →
 *   `manager.waitFor(taskId, undefined, ctx.signal)` → signal abort → reject
 *   `SubAgentAbortError`.
 *
 * Why a real ACI registry + real manager + fake spawn (not a fake manager):
 *   the proposition is "abort really reaches waitFor". Everything except the
 *   worker child process (never actually spawned in a unit test) uses
 *   production implementations: `createDefaultAciRegistry` →
 *   `createAciExecutor` (double-layer executor, same shape as build-engine),
 *   the manager's real waitFor polling / abort branches, and the `spawn` seam
 *   injects only a never-emitting fake child. With a fake manager, waitFor's
 *   abort branch would be written by the test itself and the proposition
 *   degrades to a tautology (mutation-probed: removing `controller.abort()`
 *   from the Esc branch turns the case red — not a hollow test).
 *
 * Depth honesty: model steps come from `createStubModel` (no real LLM) and
 * the worker is a fake ChildProcess (never really spawned). Real-model e2e
 * lives in `archive/tests-real-llm/`; this file asserts nothing at that layer.
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

/** Minimal valid env (the registry only consumes the web field). */
const webEnv = { web: { searchUrl: undefined, proxy: undefined } };

/** A fake worker that never emits (only killed on abort / shutdown). */
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

/** Poll until cond is true (stdin async parsing + React commit both lag). */
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
  /** Observation surface: the manager's real exit (waitFor rejection) + that spawn happened. */
  readonly events: string[];
  readonly waitRejected: () => unknown;
  readonly quitCalls: () => number;
  readonly typeText: (text: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * Mount a TUI where "the model calls spawn_subagent(wait:true) → the handler
 * blocks forever in waitFor": production assembly for everything except the
 * worker child process.
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
  // Observe the manager's real exit: once abort arrives, waitFor must reject
  // with SubAgentAbortError — the upstream fact the spawn_subagent handler
  // normalizes to cancelled.
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
              // `title` is required on spawn_subagent (card line 1 contract);
              // a stub without it would be rejected before the worker spawns
              // and the abort chain under test would never arm.
              input: { task: "sleep forever", title: "wait test", wait: true },
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

  /** 60ms per key: mockInput goes through stdin async parsing and bursts drop
   *  keys (observed: "hi" sent back-to-back + immediate Enter → input never
   *  lands, the turn never starts, spawn never happens). */
  const typeText = async (text: string): Promise<void> => {
    for (const ch of text) {
      setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
    }
    setup.mockInput.pressEnter();
  };

  // Send a message → wait for spawn → wait until the session really enters
  // running-fg. The last step is mandatory: Esc / quit abort only takes effect
  // in running-fg; racing with React commit the keypress can land in the idle
  // branch and abort is never sent (the test would be a hollow green light).
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

describe("打断抵达子代理 wait 链（SC15 Esc / SC12 /quit）", () => {
  test("SC15: running-fg + Esc → waitFor 以 SubAgentAbortError 拒绝", async () => {
    const app = await mountWaitingApp();
    try {
      // running-fg → Esc takes the foreground-interrupt arm and aborts this session.
      app.setup.mockInput.pressEscape();
      await until(
        () => app.events.includes("waitFor-rejected"),
        8000,
        "waitFor 未收到 abort"
      );

      expect(app.waitRejected()).toBeInstanceOf(Error);
      expect((app.waitRejected() as Error).name).toBe("SubAgentAbortError");

      // On-screen wrap-up: abort converges the whole turn as cancelled and the
      // app emits the interrupt notice (exact wording depends on whether the
      // delta is 0; here we only pin the fact `已打断` ("interrupted") appears).
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
      // No background sessions → /quit needs no second confirmation and goes
      // straight to wrap-up.
      await app.typeText("/quit");
      await until(
        () => app.events.includes("waitFor-rejected"),
        8000,
        "/quit 未 abort 前台 wait"
      );
      // The quit really completes (onQuit called) — without the abort this would
      // wait the 7200s wall clock and fail in the 8s window; that is exactly the
      // proposition.
      await until(() => app.quitCalls() === 1, 8000, "/quit 未完成收尾");

      expect((app.waitRejected() as Error).name).toBe("SubAgentAbortError");
      expect(app.quitCalls()).toBe(1);
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
