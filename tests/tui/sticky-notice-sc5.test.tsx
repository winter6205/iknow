/** @jsxImportSource @opentui/react */
/**
 * tests/tui/sticky-notice-sc5.test.tsx
 *
 * spec `specs/transport-continue-persist.md` SC5 / invariant 3: the
 * abnormal-stop notice is **sticky** — it stays on screen until an explicit
 * user action (dismiss / send the next message); no TTL auto-retract.
 *
 * Two invariants (this file is the only place pinning them):
 *  1. no TTL — after several silence-timer cycles the notice is on screen, unchanged;
 *  2. only an explicit user action (next message) clears it; the clearing is
 *     not causally tied to "another turn finished".
 *
 * Timing injection: `streamingSilenceNoticeMs` (the component's existing test
 * injection seam) squeezed to 150ms. That timer is the only scheduled source
 * that can still touch the notice after a turn ends; with the cycle shrunk to
 * 150ms, any regression where "a timer retracts the notice / rewrites it to
 * waiting text" surfaces within hundreds of milliseconds, no real second-scale
 * sleeps needed; the test then pumps many frames at a 50ms step to cover
 * several timer cycles.
 *
 * Same pattern as error-stop-notice.test.tsx: a fake bridge injects a resolved
 * TuiPostResult, pinning only the app-layer notice lifecycle; wire generation
 * and pass-through are pinned at the hub layer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import {
  createInflightRegistry,
  type InflightRegistry,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

/** Stable substring of the abnormal-stop notice (abnormalStopNoticeLines → apiErrorNoticeLine). */
const ABNORMAL_NOTICE_NEEDLE = "API error (404)";
/** Stable substring of the streaming-silence notice (STREAMING_SILENCE_NOTICE_LINES). */
const SILENCE_NOTICE_NEEDLE = "Waiting for model output";
/**
 * Injected silence threshold: ~1/400 of the 60s default. The silence timer is
 * the only scheduled source that can still touch the notice after a turn ends,
 * so squeezing the cycle to 150ms lets a sub-second observation window cover
 * many timer cycles.
 */
const INJECTED_SILENCE_MS = 150;
/**
 * Sticky-survival observation window: pump frames in 50ms steps (not one long
 * sleep), totaling ≥ 16 injected-threshold cycles — any timer-driven
 * auto-retract / text rewrite lands inside the window.
 */
const STICKY_SURVIVAL_WINDOW_MS = 2500;
const PUMP_STEP_MS = 50;

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
  }
}

/** Pump many frames: render once per step so any pending timer gets a chance to land. */
async function pumpFrames(setup: TestRendererSetup, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
    await setup.renderOnce();
  }
}

/** Script for one turn; absent fields take defaults (wait + finish by stopReason). */
interface TurnScript {
  readonly stopReason: TuiPostResult["stopReason"];
  readonly apiError?: { readonly status?: number; readonly message: string };
  /** non-empty → this turn blocks on this promise before returning (simulates an in-flight turn). */
  readonly gate?: Promise<void>;
  /** set when this turn enters postMessage (lets the test prove the turn is in flight). */
  readonly entered?: { value: boolean };
}

interface MountedApp {
  readonly setup: TestRendererSetup;
  readonly inflight: InflightRegistry;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
}

async function mount(opts: {
  readonly scripts: ReadonlyArray<TurnScript>;
  readonly waitMs: number;
  readonly streamingSilenceNoticeMs?: number;
}): Promise<MountedApp> {
  const convId = "conv-sticky-sc5";
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-sticky-sc5-"));
  const inflight = createInflightRegistry();
  const calls = { n: 0 };
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: convId,
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? convId,
    postMessage: async () => {
      const script =
        opts.scripts[calls.n] ?? opts.scripts[opts.scripts.length - 1]!;
      calls.n += 1;
      inflight.mark(convId);
      try {
        if (script.entered !== undefined) script.entered.value = true;
        if (script.gate !== undefined) {
          await script.gate;
        } else {
          await new Promise((r) => setTimeout(r, opts.waitMs));
        }
        return {
          conversationId: convId,
          finalText: "",
          stopReason: script.stopReason,
          turnCount: 0,
          jsonMode: false,
          lastUsage: null,
          ...(script.apiError !== undefined
            ? { apiError: script.apiError }
            : {}),
        };
      } finally {
        inflight.unmark(convId);
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("continueSession unused in sticky-notice SC5 tests");
    },
    rewindSession: async (_id, _head) => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
  };
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
      {...(opts.streamingSilenceNoticeMs !== undefined
        ? { streamingSilenceNoticeMs: opts.streamingSilenceNoticeMs }
        : {})}
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
    inflight,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      // mockInput parses stdin asynchronously; typing too fast drops keys. The
      // input-line echo (`❯ <text>`) is the landing proof; retype after clearing
      // if it never lands.
      const inputLanded = (frame: string): boolean =>
        frame.includes(`❯ ${text}`) || frame.includes(`❯ ${text} `);
      const clear = async (): Promise<void> => {
        for (let i = 0; i < 24; i++) setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 40));
        await setup.renderOnce();
      };
      const typeOnce = async (): Promise<void> => {
        for (const ch of text) {
          setup.mockInput.pressKey(ch);
          await new Promise((r) => setTimeout(r, 40));
          await setup.renderOnce();
        }
        await new Promise((r) => setTimeout(r, 80));
        await setup.renderOnce();
      };
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 80));
      await setup.renderOnce();
      await clear();
      await typeOnce();
      const start = Date.now();
      while (!inputLanded(setup.captureCharFrame())) {
        if (Date.now() - start > 4000) {
          throw new Error(
            `typeText did not land ${JSON.stringify(text)}:\n${setup.captureCharFrame()}`
          );
        }
        await clear();
        await typeOnce();
      }
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("TUI sticky 异常停 notice（spec SC5）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("SC5: 异常停 notice 无 TTL —— 静默计时器多周期到期后原样在屏", async () => {
    const app = await mount({
      scripts: [
        {
          stopReason: "protocolError",
          apiError: {
            status: 404,
            message: "No active credentials for provider: 9router",
          },
        },
      ],
      waitMs: 400,
      streamingSilenceNoticeMs: INJECTED_SILENCE_MS,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // Positive control: the injected silence threshold really fires (the
    // waiting text lands while the turn is in flight). Without this, the
    // survival window below could pass vacuously if the timer was never armed.
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_NEEDLE), 4000);
    // The notice lands only after the closing notification (turn settlement at
    // the tail of processChatLine) completes.
    await untilFrame(
      app.setup,
      (f) => f.includes(ABNORMAL_NOTICE_NEEDLE),
      8000
    );

    // Frame-by-frame assertions inside the survival window: any dropped frame
    // fails (not just a window-end check).
    const start = Date.now();
    let pumped = 0;
    while (Date.now() - start < STICKY_SURVIVAL_WINDOW_MS) {
      await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
      await app.setup.renderOnce();
      pumped += 1;
      const frame = app.setup.captureCharFrame();
      expect(frame).toContain(ABNORMAL_NOTICE_NEEDLE);
      // The silence timer is already torn down in the turn's finally block: it
      // must not rewrite the abnormal-stop text back to "still waiting" (a
      // sticky notice's text is only overwritten by a new explicit state, never
      // revisited by an expired timer).
      expect(frame).not.toContain(SILENCE_NOTICE_NEEDLE);
    }
    // The window really covers several injected-threshold cycles (guards the
    // pump logic against degenerating into a no-op).
    expect(pumped * PUMP_STEP_MS).toBeGreaterThanOrEqual(
      INJECTED_SILENCE_MS * 8
    );
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("SC5: 异常停 notice 仅由用户明确动作（发下一条消息）清除", async () => {
    const secondTurnEntered = { value: false };
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const app = await mount({
      scripts: [
        {
          stopReason: "protocolError",
          apiError: {
            status: 404,
            message: "No active credentials for provider: 9router",
          },
        },
        { stopReason: "completed", gate, entered: secondTurnEntered },
      ],
      waitMs: 400,
    });
    try {
      await untilFrame(app.setup, (f) => f.includes("Version"));

      await app.typeText("go");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes(ABNORMAL_NOTICE_NEEDLE),
        8000
      );

      // (a) no auto-dismiss while idle: still on screen after a time span past any meaningful silence threshold.
      await pumpFrames(app.setup, 600);
      expect(app.setup.captureCharFrame()).toContain(ABNORMAL_NOTICE_NEEDLE);

      // (b) typing alone (a draft) is not an explicit action: the notice must remain.
      await app.typeText("go2");
      expect(app.setup.captureCharFrame()).toContain(ABNORMAL_NOTICE_NEEDLE);

      // (c) user action = submit. The clearing happens at the moment of the
      // action — the second turn is still gated in flight, so "time passed /
      // this turn settled" explanations cannot hold.
      await app.pressEnter();
      await until(() => secondTurnEntered.value, 8000, "second-turn-inflight");
      await app.setup.renderOnce();
      const inFlight = app.setup.captureCharFrame();
      expect(inFlight).not.toContain(ABNORMAL_NOTICE_NEEDLE);
      expect(inFlight).not.toContain(SILENCE_NOTICE_NEEDLE);

      // (d) a new turn settling normally does not backfill the old abnormal-stop text (stickiness ends at the user action).
      releaseGate();
      await until(() => app.inflight.ids().size === 0, 8000, "second-settled");
      await pumpFrames(app.setup, 300);
      expect(app.setup.captureCharFrame()).not.toContain(
        ABNORMAL_NOTICE_NEEDLE
      );

      expect(rejections).toHaveLength(0);
    } finally {
      releaseGate();
      await app.destroy();
    }
  }, 30_000);

  test("清理: 移除 unhandledRejection 监听", () => {
    process.off("unhandledRejection", listener);
  });
});
