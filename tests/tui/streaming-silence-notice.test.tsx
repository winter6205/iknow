/** @jsxImportSource @opentui/react */
/**
 * tests/tui/streaming-silence-notice.test.tsx
 *
 * Streaming-arm silence past the threshold (default 60_000, host-injectable;
 * the on-screen copy carries no duration) → the notice text becomes "Waiting
 * for model output" (English, consistent with the sticky-notice convention);
 * the box does not auto-dismiss (sticky discipline); one rewrite per silence
 * episode: any resumed stream event clears the waiting copy (it asserts "no
 * new stream bytes", false once bytes arrive) and a later silence episode
 * may land it again; turn-end behavior is unaffected (existing cancelled /
 * completed / abnormal stopReason settlement paths).
 *
 * Phase gate (second half of this file): "no streaming bytes" is an anomaly
 * signal only in the **model phase**. During tool execution (incl. permission
 * / ask waits) the harness sends no stream events by design — that phase must
 * not show the waiting text; on successful settlement, if the waiting text is
 * still on screen (not overridden by a more specific source), it is cleared —
 * no stale hints linger.
 *
 * Uses a fake bridge + an injectable silence threshold (default 60_000 →
 * tests use 150-3000ms) to avoid real sleeps; the fake bridge emits no
 * onStream events → simulates "connection established but the model is
 * stuck producing nothing"; sibling cases pulse text_delta mid-turn
 * (streaming bytes resume) → verifying the resume clears the waiting copy,
 * a continuing stream does not re-raise it (spam guard), and a fresh
 * cross-threshold gap lands it again.
 *
 * Turn settlement is controlled explicitly by the release latch, not by wall
 * clock — all assertions land inside the "turn in flight" interval; load only
 * lengthens the observation window, it never squeezes settlement between two
 * assertions. A fixed waitMs under load eats the observation window (the root
 * cause of this file's earlier flakiness).
 *
 * Does not touch harness timers / idle decisions — this file pins only the TUI
 * notice feedback layer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  createToolEventSink,
  nextToolPhaseActive,
  resolveStreamingSilenceNoticeMs,
} from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";

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

/**
 * Turn control plane: the bridge hands onStream to the test; event timing and
 * settlement timing are fully test-driven (not wall clock). Load only
 * **lengthens** the observation window — settlement can never squeeze between
 * two assertions, which was this file's earlier flakiness root cause (a fixed
 * waitMs ring that load would eat up).
 */
interface TurnControl {
  /** The turn has entered postMessage (event channel ready); await before controlling. */
  readonly started: Promise<void>;
  /** Emit one text_delta (streaming bytes resume). */
  pulse(): void;
  /** Emit tool_call_start (model yields tool_use → tool phase, no stream events after). */
  toolStart(): void;
  /** Emit transport_retry (a more-specific notice source: sets its own progress copy). */
  retry(): void;
  /** Emit agent_status (tool batch settled, next model call starting → back to model phase). */
  agentStatus(): void;
  /** Release the turn so postMessage returns its stopReason (settlement takes the existing completed path). */
  release(): void;
}

interface FakeBridgeOptions {
  readonly stopReason: TuiPostResult["stopReason"];
  /**
   * true: postMessage returns immediately without waiting for release — pins
   * "the waiting text must not land when the turn is shorter than the
   * threshold" (threshold semantics: emitting before the window is wrong).
   */
  readonly returnImmediately?: boolean;
}

/** tool_call_start's tool id (shared by the phase-gate cases). */
const TOOL_USE_ID = "toolu_silence_1";

/** Model-call boundary event (tool batch settled, re-entering the model phase). */
function agentStatusEvent(): HarnessStreamEvent {
  return { type: "agent_status", lastTool: "bash", openTodoLines: [] };
}

/** Stable substring of the silence waiting text (English copy, single render surface STREAMING_SILENCE_NOTICE_LINES). */
const SILENCE_NOTICE_LINE = "Waiting for model output";

/** Stable substring of the transport_retry progress copy (a more-specific notice source). */
const RETRY_NOTICE_LINE = "连接重试";

function fakeBridge(opts: FakeBridgeOptions): {
  bridge: TuiBridge;
  control: TurnControl;
} {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-silence",
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
    conversationId: "conv-silence",
    finalText: "",
    stopReason: opts.stopReason,
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
  // Events and settlement are always test-driven via control: onStream is
  // captured when postMessage is entered; the turn stays "in flight" until release.
  let stream: ((event: HarnessStreamEvent) => void) | undefined;
  let releaseTurn: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const emit = (event: HarnessStreamEvent): void => {
    stream?.(event);
  };
  const control: TurnControl = {
    started,
    pulse: () => emit({ type: "text_delta", text: "hi" }),
    toolStart: () =>
      emit({ type: "tool_call_start", id: TOOL_USE_ID, name: "bash" }),
    retry: () =>
      emit({
        type: "transport_retry",
        attempt: 1,
        maxAttempts: 3,
        detail: "429",
      }),
    agentStatus: () => emit(agentStatusEvent()),
    release: () => releaseTurn?.(),
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-silence",
    postMessage: async ({ onStream }) => {
      inflight.mark("conv-silence");
      try {
        stream = onStream;
        markStarted?.();
        if (opts.returnImmediately !== true) await released;
        return reply;
      } finally {
        inflight.unmark("conv-silence");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      // stub never compacts: the no-compaction arm of CompactReason.
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error(
        "continueSession unused in streaming-silence-notice tests"
      );
    },
    rewindSession: async (_id, _head) => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
    abortSubagentTask: () => false,
    openSession: async () => {
      throw new Error("unused: no session is opened here");
    },
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
  return { bridge, control };
}

async function mount(opts: {
  readonly bridgeOpts: FakeBridgeOptions;
  readonly streamingSilenceNoticeMs: number;
}): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
  control: TurnControl;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-silence-"));
  const { bridge, control } = fakeBridge(opts.bridgeOpts);
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
      streamingSilenceNoticeMs={opts.streamingSilenceNoticeMs}
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
    control,
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

describe("TUI 流式静默 notice（T2）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("流式臂无事件跨阈值 → notice 改写为等待文案（turn 在飞期间无 TTL 自动消失）", async () => {
    // Silence threshold = 150ms; the turn is held by the release latch (not
    // wall clock) → the observation window is unbounded, load only lengthens
    // it. Pins "sticky = no TTL self-dismiss"; clearing the waiting text at
    // turn settlement is pinned by a separate case below (process hint, split
    // from the abnormal-stop sticky).
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    // Wait for the silence timer to fire + the notice to render
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 4000);

    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // Wait far beyond the threshold: the turn is still in flight (not released) → the box must not auto-dismiss
    await new Promise((r) => setTimeout(r, 800));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // The silence period must not cause unhandled rejections / console pollution
    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("流式字节恢复即清等待文案；持续流不重复触发；新的跨阈值静默再次落屏（每 episode 一次，不 spam）", async () => {
    // Timeline (threshold 3000ms, turn held by the release latch):
    //   silence crosses the threshold → the waiting text lands
    //   control.pulse() emits text_delta → the resume clears the waiting
    //     copy (the copy claims "no new stream bytes", false once bytes
    //     arrive)
    //   stream keeps flowing (each gap far below the threshold) → the copy
    //     is never re-raised: one notice per silence episode (spam guard)
    //   pulses stop, a fresh cross-threshold gap → the copy lands again
    //     (the clear is not a one-shot disarm)
    // The turn is never released → settlement cannot race the assertions.
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 3000,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    // Resume clears the waiting copy. The clear runs synchronously inside
    // pulse() (onStream passes the choke point before return); the frame is
    // polled below the re-armed 3000ms window, so a re-land can never be
    // mistaken for "not yet cleared".
    app.control.pulse();
    await untilFrame(app.setup, (f) => !f.includes(SILENCE_NOTICE_LINE), 400);

    // A continuing stream must not re-raise the waiting copy: each 100ms
    // pulse lands far inside the 3000ms window, so between pulses the steady
    // frame is observable with a single render (no state transition races).
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 100));
      app.control.pulse();
      await app.setup.renderOnce();
      expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);
    }

    // Silence resumes past the threshold → the waiting text lands again.
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("turn 正常完成 → silence notice 不抢 turn-end 的 completed 收尾", async () => {
    // returnImmediately: the turn completes before the threshold (150ms) → the
    // timer is cleared by settlement within a few microtasks after arming, so
    // there is no wall-clock race of "does the timer fire first or the turn
    // finish first" (that race was the flakiness of the old fixed-waitMs
    // version). Verifies this test does not emit a false-positive "Waiting for
    // model output" (threshold semantics correct: nothing emitted before the window).
    const app = await mount({
      bridgeOpts: { stopReason: "completed", returnImmediately: true },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // Sleep past 4× the threshold: if the timer were not cleared by settlement, it would have long since fired and shown.
    await new Promise((r) => setTimeout(r, 600));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("工具相位跨静默阈值 → 不落等待文案；回到模型相位后仍会给出提示", async () => {
    // Regression pin: the harness produces no stream events during tool
    // execution (by design), yet previously silence past the threshold in
    // that phase falsely
    // reported "Waiting for model output / Check your network". The phase is
    // driven explicitly by control (threshold 150ms): toolStart() enters the
    // tool phase (turn held by release, phase persists) → sleep past 4+
    // threshold cycles with no waiting text landing → agentStatus() returns to
    // the model phase → the next full window does show the waiting text.
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    app.control.toolStart();
    // Tool phase: past 4+ threshold cycles, no waiting text lands.
    await new Promise((r) => setTimeout(r, 650));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);

    // Back in the model phase (agent_status) and still silent → the next full
    // window does show the waiting text: suppression is phase-scoped, not
    // whole-turn.
    app.control.agentStatus();
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("成功收尾清除等待文案（过程性提示，不残留过期网络提示）", async () => {
    // Threshold 150ms: the waiting text lands first (the turn is held by the
    // release latch, so it is always observed) → release settles the turn as
    // completed → same treatment as retry progress: the process hint clears on
    // successful settlement. Landing and settlement no longer share a
    // wall-clock window — load cannot squeeze settlement between two assertions
    // (the flakiness root cause of the old fixed-waitMs version).
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    // Release the turn → settlement lands (clears the timer + the successful
    // settlement branch); the waiting text must disappear.
    app.control.release();
    await untilFrame(app.setup, (f) => !f.includes(SILENCE_NOTICE_LINE), 8000);
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("等待文案不指控网络", async () => {
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes(SILENCE_NOTICE_LINE),
      8000
    );
    expect(frame).not.toContain("Check your network");

    expect(rejections).toHaveLength(0);
    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("模型相位已上屏的等待文案在 tool_call_start 后立即消失", async () => {
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    app.control.toolStart();
    await untilFrame(app.setup, (f) => !f.includes(SILENCE_NOTICE_LINE), 8000);
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("模型相位已上屏的等待文案在 text_delta 恢复后立即消失（不误清其他来源 notice）", async () => {
    // On the configured model route a large tool input arrives as one delta
    // after 65-174s of silence, so "bytes resumed but the box still claims no
    // new stream bytes" is a routine false statement, not a corner case.
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 3000,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    // (a) resumed streaming bytes clear the waiting text; the next silence
    // episode must then re-arm and land again (the clear is not a one-shot
    // disarm).
    app.control.pulse();
    await untilFrame(app.setup, (f) => !f.includes(SILENCE_NOTICE_LINE), 400);
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    // (b) the clear rule is silence-copy-scoped only: transport_retry owns a
    // more-specific notice. The retry + delta pair runs synchronously through
    // the choke point (the silence clear fires first, then retry sets its own
    // copy); poll for the first frame showing it, bounded well below the
    // re-armed 3000ms window so the silence copy cannot re-land inside it.
    app.control.retry();
    app.control.pulse();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes(RETRY_NOTICE_LINE) && !f.includes(SILENCE_NOTICE_LINE),
      400
    );
    expect(frame).toContain(RETRY_NOTICE_LINE);
    expect(frame).not.toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监听", () => {
    process.off("unhandledRejection", listener);
  });
});

describe("nextToolPhaseActive（相位门纯函数）", () => {
  test("模型相位 + tool_call_start → 进工具相位", () => {
    expect(
      nextToolPhaseActive(false, {
        type: "tool_call_start",
        id: "t1",
        name: "bash",
      })
    ).toBe(true);
  });

  test("工具相位 + agent_status / env_snapshot → 回模型相位（模型调用边界）", () => {
    expect(
      nextToolPhaseActive(true, {
        type: "agent_status",
        lastTool: "bash",
        openTodoLines: [],
      })
    ).toBe(false);
    expect(
      nextToolPhaseActive(true, {
        type: "env_snapshot",
        snapshot: {
          cwd: "/tmp/proj",
          gitBranch: null,
          gitStatus: null,
          dirtyCount: null,
          diffPreview: null,
          degradeReason: null,
        },
      })
    ).toBe(false);
  });

  test("增量 / 图进度不翻转相位（run_graph 执行中仍属工具相位）", () => {
    expect(nextToolPhaseActive(true, { type: "text_delta", text: "x" })).toBe(
      true
    );
    expect(
      nextToolPhaseActive(true, { type: "graph_progress", snapshot: null })
    ).toBe(true);
    expect(
      nextToolPhaseActive(false, { type: "thinking_delta", text: "x" })
    ).toBe(false);
  });
});

describe("resolveStreamingSilenceNoticeMs（阈值默认值 SSOT）", () => {
  // specs/transport-continue-persist.md invariant 3 pins the default window;
  // nothing else in the suite would catch a revert to a shorter one (every
  // TUI case injects its own threshold to avoid real sleeps).
  test("无注入 → 60s 默认；宿主注入优先于默认", () => {
    expect(resolveStreamingSilenceNoticeMs(undefined)).toBe(60_000);
    expect(resolveStreamingSilenceNoticeMs(150)).toBe(150);
  });
});
