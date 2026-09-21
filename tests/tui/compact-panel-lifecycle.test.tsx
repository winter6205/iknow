/** @jsxImportSource @opentui/react */
/**
 * tests/tui/compact-panel-lifecycle.test.tsx
 *
 * **App-level lifecycle** tests for the compact progress panel (bun:test).
 *
 * Complements `compact-progress.test.tsx` (pure functions + component
 * smoke): that file covers reduction and rendering, this one covers the
 * **app.tsx wiring contract** — when the panel mounts and when it unmounts.
 * Direct reason for existing: panel unmount relies on the HOLD_MS timer,
 * which was originally armed only in the manual path's
 * `settleCompactPanelFor`; a mid-turn auto-compact terminal event set
 * `terminal` without arming the timer, leaving the `✓ done` panel on screen
 * forever and permanently inflating the chrome row account (+7 rows).
 *
 * Covers:
 *  1. mid-turn compaction_completed → panel appears → unmounts within
 *     HOLD_MS after the terminal state (regression guard: un-unmounted =
 *     permanent residue);
 *  2. compaction_started then turn end with no terminal event → the finally
 *     sweep unmounts immediately (a missed settle must not leave a fake
 *     in-flight panel).
 */
import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import type { CompactReason } from "../../src/harness/compress/index.js";
import { COMPACT_HOLD_MS } from "../../src/tui/compact-progress.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/** Frame wait: mockInput bytes parse asynchronously via stdin, so poll
 *  renderOnce. */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout ${label}:\n${setup.captureCharFrame()}`);
}

/** Poll until the assertion holds (panel unmount is async: it disappears
 *  only after the hold timer fires). */
async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
}

/**
 * Mount a TuiApp whose stub model emits the given event sequence in the
 * turn's streaming arm (`streamEventsByStep` is the stub-model's existing
 * seam, same usage as the max-turns / hub tests).
 */
async function mountWithTurnEvents(
  events: ReadonlyArray<HarnessStreamEvent>
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-compact-life-"));
  const deps = makeDeps([assistantResult({ texts: ["ok"] })], {
    streamEventsByStep: [events],
  });
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps,
    inflight: createInflightRegistry(),
  });
  return mountWithBridge(bridge, dataDir);
}

/** Manual path: swap bridge.compactSession for a given implementation
 *  (wrapping the real bridge). */
async function mountWithCompactSession(
  result:
    { readonly compacted: boolean; readonly reason: CompactReason } | Error
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-compact-life-"));
  const inner = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    inflight: createInflightRegistry(),
  });
  const bridge: typeof inner = {
    ...inner,
    compactSession: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return mountWithBridge(bridge, dataDir);
}

async function mountWithBridge(
  bridge: ReturnType<typeof createTuiBridge>,
  dataDir: string
): Promise<DrivenApp> {
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 30));
      }
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("compact 面板 app 级生命周期（Spec review High 回归防线）", () => {
  test("turn 内 compaction_completed：面板出现，终态后 HOLD_MS 内自动卸载（不永久残留）", async () => {
    const app = await mountWithTurnEvents([
      { type: "compaction_started", droppedCount: 5 },
      { type: "compaction_completed", summaryLen: 120, durationMs: 800 },
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // Panel appears (mid-turn auto-compact was previously fully silent to
    // the user; this is its first visualization).
    await untilFrame(app.setup, (f) => f.includes("Compacting"), 8000, "panel");
    // Terminal state: the done status line is visible (✓ + done).
    await untilFrame(
      app.setup,
      (f) => f.includes("✓") && f.includes("done"),
      8000,
      "terminal"
    );

    // **Key assertion**: the panel must vanish after HOLD_MS. Before the
    // fix the turn path never armed the timer, so this step times out
    // (panel stuck on screen + chrome row account permanently +7).
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      COMPACT_HOLD_MS + 6000,
      "panel-unmount"
    );

    await app.destroy();
  }, 30_000);

  test("turn 内 compaction_started 后无终态事件 → turn finally 强扫，终帧不留面板（不留伪在途）", async () => {
    const app = await mountWithTurnEvents([
      { type: "compaction_started", droppedCount: 3 },
      // Deliberately no completed / failed / cancelled: simulates the
      // "missing terminal" path from a reactive early return / swallowed
      // event.
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // Both panel mount and the finally sweep happen inside the same turn,
    // possibly a frame flash — the contract is that the **final frame**
    // holds no panel, so assert on the settled frame after the turn ends
    // (before the fix: the panel lingered forever with
    // `◐ Ns · 3 messages folded` and this assertion failed).
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "answer");
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      6000,
      "sweep-unmount"
    );

    await app.destroy();
  }, 30_000);

  test("手动 /compact no-op（compacted:false）→ 面板清除，不留伪造 done（验收 9）", async () => {
    const app = await mountWithCompactSession({
      compacted: false,
      reason: "messages_too_few",
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // Seed a session first (a draft goes through the guard branch, not the
    // panel path).
    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "seed");

    await app.typeText("/compact");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) => f.includes("Nothing to compact"),
      8000,
      "noop-notice"
    );
    // no-op = compaction never happened: the panel must be cleared (before
    // the fix the fake done left `✓ done`).
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      3000,
      "noop-immediate-clear"
    );

    await app.destroy();
  }, 30_000);

  test("手动 /compact 抛错 → 英文失败 notice（catch 路径 / 验收 16）", async () => {
    const app = await mountWithCompactSession(new Error("boom"));
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "seed");

    await app.typeText("/compact");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) => f.includes("Compaction failed: boom"),
      8000,
      "failed-notice"
    );

    await app.destroy();
  }, 30_000);
});
