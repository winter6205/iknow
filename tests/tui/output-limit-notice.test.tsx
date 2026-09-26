/** @jsxImportSource @opentui/react */
/**
 * tests/tui/output-limit-notice.test.tsx
 *
 * spec `specs/model-output-truncation.md` SC8 / SC9 / SC11 — the TUI's sticky
 * notice lane presenting an output-limit-truncated turn, live and on reopen.
 *
 * The hub passes the deterministic English `outputLimitNotice` through the
 * bridge verbatim; `abnormalStopNoticeLines` shows it IN PLACE OF the generic
 * `turn 未成功结束` line for a `nonSuccessStop`, and `turnLaneNoticeFor` seeds
 * the lane from a reopened session's last settled outcome. A committed partial
 * answer stays the turn's visible text; an unknown outcome shows neither a
 * notice nor a completion label.
 *
 * Same shape as error-stop-notice.test.tsx: a fake bridge injects a resolved
 * TuiPostResult (live) or `initialSession` seeds the reopen; the notice-lane
 * mapping is pinned at the app layer, the wire generation at the hub layer.
 *
 * Frame is 220 wide so the full one-line notice lands on a single visual row
 * (the abnormal line and this English line are then compared un-wrapped).
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
import {
  attachSession,
  type TuiLoadedSessionFile,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { OUTPUT_LIMIT_NOTICE, knownTurnOutcome } from "../../src/session-api/contract.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

/** The generic abnormal-stop line the output-limit notice must displace. */
const GENERIC_STOP_NEEDLE = "turn 未成功结束";
/** The committed partial assistant text a truncated turn must keep showing. */
const COMMITTED_TEXT = "partial committed answer text";

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

const msg = (
  text: string,
  role: "user" | "assistant" = "user"
): AnthropicNativeMessage => ({
  role,
  content: [{ type: "text", text }],
});

function fileWithCommittedAnswer(id: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    conversation_id: id,
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: now,
    messages: [msg("go"), msg(COMMITTED_TEXT, "assistant")],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    checkpoints: [],
  };
}

interface LiveOptions {
  readonly stopReason: TuiPostResult["stopReason"];
  /** Present → the hub's verbatim output-limit notice; absent → no truncation. */
  readonly outputLimitNotice?: string;
}

function fakeBridge(opts: LiveOptions): TuiBridge {
  const convId = "conv-output-limit";
  const inflight = createInflightRegistry();
  const file = fileWithCommittedAnswer(convId);
  const reply: TuiPostResult = {
    conversationId: convId,
    finalText: COMMITTED_TEXT,
    stopReason: opts.stopReason,
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
    ...(opts.outputLimitNotice !== undefined
      ? { outputLimitNotice: opts.outputLimitNotice }
      : {}),
  };
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? convId,
    postMessage: async () => {
      inflight.mark(convId);
      try {
        await new Promise((r) => setTimeout(r, 20));
        return reply;
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
      throw new Error("continueSession unused in output-limit-notice tests");
    },
    rewindSession: async (_id, _head) => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
    abortSubagentTask: () => false,
  };
}

interface Mounted {
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
}

async function mount(
  bridge: TuiBridge,
  initialSession?: TuiSessionState
): Promise<Mounted> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-output-limit-"));
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
      {...(initialSession ? { initialSession } : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 220, height: 50, exitOnCtrlC: false, consoleMode: "disabled" }
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

describe("TUI output-limit notice — live turn", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("nonSuccessStop + outputLimitNotice → 英文 notice 顶替通用『未成功结束』文案，保留已提交文本 (SC8/SC9)", async () => {
    const app = await mount(
      fakeBridge({
        stopReason: "nonSuccessStop",
        outputLimitNotice: OUTPUT_LIMIT_NOTICE,
      })
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes(OUTPUT_LIMIT_NOTICE), 8000);
    const frame = app.setup.captureCharFrame();
    // The generic abnormal-stop line must not co-exist — the notice replaces it.
    expect(frame).not.toContain(GENERIC_STOP_NEEDLE);
    // The committed partial answer is still the turn's visible text.
    expect(frame).toContain(COMMITTED_TEXT);
    // It is not folded into the assistant body (the body stays the committed text).
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("nonSuccessStop WITHOUT notice → 通用『未成功结束』文案不变 (SC8 negative control)", async () => {
    const app = await mount(fakeBridge({ stopReason: "nonSuccessStop" }));
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes(`${GENERIC_STOP_NEEDLE}（nonSuccessStop）`),
      8000
    );
    const frame = app.setup.captureCharFrame();
    // The output-limit copy must not leak into a non-truncating abnormal stop.
    expect(frame).not.toContain(OUTPUT_LIMIT_NOTICE);

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监听", () => {
    process.off("unhandledRejection", listener);
  });
});

describe("TUI output-limit notice — reopen path", () => {
  const convId = "conv-reopen";

  test("reopen a truncated session → notice lane shows the same English line + committed text (SC8)", async () => {
    const loaded: TuiLoadedSessionFile = {
      ...fileWithCommittedAnswer(convId),
      lastTurnOutcome: knownTurnOutcome("nonSuccessStop", "truncation"),
    };
    const initial = attachSession(loaded);
    const app = await mount(fakeBridge({ stopReason: "completed" }), initial);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    // No turn is sent: the lane is seeded from the reopened session state.
    await untilFrame(app.setup, (f) => f.includes(OUTPUT_LIMIT_NOTICE), 8000);
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain(COMMITTED_TEXT);
    expect(frame).not.toContain(GENERIC_STOP_NEEDLE);
    await app.destroy();
  }, 30_000);

  test("reopen an unknown-outcome session → no notice, no completion label (SC11)", async () => {
    const loaded: TuiLoadedSessionFile = {
      ...fileWithCommittedAnswer(convId),
      lastTurnOutcome: { terminal: "unknown" },
    };
    const initial = attachSession(loaded);
    const app = await mount(fakeBridge({ stopReason: "completed" }), initial);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    // Let the render settle, then confirm the lane stays silent.
    await new Promise((r) => setTimeout(r, 400));
    await app.setup.renderOnce();
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain(COMMITTED_TEXT);
    expect(frame).not.toContain(OUTPUT_LIMIT_NOTICE);
    expect(frame).not.toContain(GENERIC_STOP_NEEDLE);
    // No "verification passed (N turns)" completion banner either.
    expect(frame).not.toContain("验证通过");
    await app.destroy();
  }, 30_000);
});
