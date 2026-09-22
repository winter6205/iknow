/** @jsxImportSource @opentui/react */
/**
 * tests/tui/interrupt-notice.test.tsx
 *
 * User-interrupt (Esc) feedback — asserts both notice branches of
 * runTurnOnce in app.tsx.
 *
 * A fake bridge injects a resolved TuiPostResult (interrupted=true/false) to
 * drive the notice rendering directly:
 *   - interrupted === true  → `已打断，checkpoint 已保存` ("interrupted, checkpoint saved")
 *   - interrupted === false → `已打断（无新内容，未落 checkpoint）` ("interrupted (no new content, no checkpoint written)")
 *
 * Why a fake bridge instead of real bridge + interrupt key sequence:
 *   the TUI interrupt sequence (submit turn → Esc → abort → cancelled
 *   persisted) involves timing (delayMs / abort races); asserting the
 *   two-branch wording through the real bridge would drag timing noise into
 *   a notice-copy test. The wire-side production of `interrupted` is already
 *   pinned at the hub layer (interrupt cases in tests/session-api/hub.test.ts)
 *   and in the hub-bridge passthrough (existing hub-bridge.test.ts patterns).
 *   This test pins only the app-layer notice mapping.
 *
 * The fake bridge must satisfy every TuiApp call surface (listSessions /
 * ensureSession / postMessage / loadSessionFile / compactSession /
 * rewindSession / inflight / contextWindow). Message rendering reads the
 * empty file returned by loadSessionFile (refresh after turnFinished
 * persists), so the notice is the only assertion surface.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

interface FakeBridgeOptions {
  readonly stopReason: "cancelled" | "completed";
  readonly interrupted?: boolean;
  /** cancelled + delta>0 → persisted file contains a checkpoint; delta=0 → empty file. */
  readonly persistCheckpoint: boolean;
  /** The low-level handler ignores the signal; the status notification should survive until wrap-up. */
  readonly backgroundRunning?: boolean;
}

function fakeBridge(opts: FakeBridgeOptions): TuiBridge {
  const inflight = createInflightRegistry();
  let file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-b1",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  const reply: TuiPostResult = {
    conversationId: "conv-b1",
    finalText: "",
    stopReason: opts.stopReason,
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
    // On cancelled the hub always carries interrupted; completed leaves it undefined (field absent).
    ...(opts.stopReason === "cancelled" && opts.interrupted !== undefined
      ? { interrupted: opts.interrupted }
      : {}),
  };
  const bridge: TuiBridge = {
    hub: undefined as never, // not consumed by this test
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-b1",
    postMessage: async ({ onStream }) => {
      inflight.mark("conv-b1");
      try {
        await new Promise((r) => setTimeout(r, 20));
        if (opts.backgroundRunning === true) {
          onStream?.({
            type: "stop_summary",
            text: "界面已停止等待，但底层操作仍在后台运行",
          });
        }
        if (opts.persistCheckpoint) {
          const now = new Date().toISOString();
          file = {
            ...file,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "q" }],
              },
            ],
            turnCount: 0,
            updatedAt: now,
            checkpoints: [
              {
                turnIndex: 0,
                messagesCount: 1,
                interruptedAt: now,
                interruptReason: "cancelled",
              },
            ],
          };
        }
        return reply;
      } finally {
        inflight.unmark("conv-b1");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({ compacted: false }),
    continueSession: async () => {
      throw new Error("continueSession unused in interrupt-notice tests");
    },
    rewindSession: async (id, _head) => {
      // Returns the unmodified file (TuiApp never hits the rewind branch; just satisfies the type surface).
      void id;
      return { file };
    },
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
  };
  return bridge;
}

async function mount(opts: FakeBridgeOptions): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-interrupt-"));
  const bridge = fakeBridge(opts);
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
  return {
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      // Warm up + clear the input (same pattern as app.test.tsx).
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

describe("TUI 打断 notice 双分支（B1）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("cancelled + interrupted=true → notice「已打断，checkpoint 已保存」", async () => {
    const app = await mount({
      stopReason: "cancelled",
      interrupted: true,
      persistCheckpoint: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("已打断，checkpoint 已保存"),
      8000,
      "interrupted-true"
    );
    // The false-branch wording must not leak in.
    expect(app.setup.captureCharFrame()).not.toContain("未落 checkpoint");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("cancelled + interrupted=false → notice「已打断（无新内容，未落 checkpoint）」", async () => {
    const app = await mount({
      stopReason: "cancelled",
      interrupted: false,
      persistCheckpoint: false,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("已打断（无新内容，未落 checkpoint）"),
      8000,
      "interrupted-false"
    );
    // The true-branch wording must not leak in.
    expect(app.setup.captureCharFrame()).not.toContain("checkpoint 已保存");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("cancelled + 后台仍运行 → notice 明确区分于普通 cancelled", async () => {
    const app = await mount({
      stopReason: "cancelled",
      interrupted: false,
      persistCheckpoint: false,
      backgroundRunning: true,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("界面已停止等待，但底层操作仍在后台运行"),
      8000
    );
    expect(app.setup.captureCharFrame()).not.toContain(
      "已打断（无新内容，未落 checkpoint）"
    );

    await app.destroy();
  }, 30_000);

  test("cancelled + interrupted 缺失 → 保留兜底 notice", async () => {
    const app = await mount({
      stopReason: "cancelled",
      persistCheckpoint: false,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("已打断当前 turn"), 8000);
    expect(app.setup.captureCharFrame()).not.toContain("checkpoint 已保存");
    expect(app.setup.captureCharFrame()).not.toContain("未落 checkpoint");

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监探", () => {
    process.off("unhandledRejection", listener);
  });
});
