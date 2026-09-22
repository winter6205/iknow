/** @jsxImportSource @opentui/react */
/**
 * tests/tui/error-stop-notice.test.tsx
 *
 * Regression: 429/network-class model failures used to take loop-engine's
 * silent path — TransportRetryExhaustedError was flattened into a normal
 * RunResult with stopReason:"protocolError" (loop-engine.ts modelStop), empty
 * finalText, and runTurnOnce's notice branch only covered the throw path and
 * cancelled → the turn ended silently with zero UI feedback.
 *
 * Fix: any stopReason that is not completed / cancelled / maxTurns renders a
 * notice (reusing the cancelled render path). maxTurns has its own completion
 * feedback (`验证通过（N 轮）` — "verification passed (N turns)") and stays out
 * of this mapping.
 *
 * ADR-0094: on transport failure the bridge passes apiError through;
 * protocolError + apiError uses the dedicated text
 * "API error (status): message" so gateway-side detail is visible.
 * The sibling case (protocolError without apiError) keeps the old
 * `turn 未成功结束` ("turn did not end successfully") text —
 * the upgrade is branched, not a replacement of the generic message.
 *
 * Same test shape as interrupt-notice.test.tsx: a fake bridge injects a
 * resolved TuiPostResult, pinning only the app-layer notice mapping; wire
 * generation and pass-through are pinned at the hub / hub-bridge layers.
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
  readonly stopReason: TuiPostResult["stopReason"];
  /** ADR-0094: simulated transport-failure summary; undefined = old generic text. */
  readonly apiError?: { readonly status?: number; readonly message: string };
  /** 4xx non-transient failures reject from run() into here (ADR-0094); set it and it rejects. */
  readonly throwLike?: unknown;
}

function fakeBridge(opts: FakeBridgeOptions): TuiBridge {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-err-stop",
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
    conversationId: "conv-err-stop",
    finalText: "",
    stopReason: opts.stopReason,
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
    ...(opts.apiError !== undefined ? { apiError: opts.apiError } : {}),
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-err-stop",
    postMessage: async () => {
      inflight.mark("conv-err-stop");
      try {
        await new Promise((r) => setTimeout(r, 20));
        if (opts.throwLike !== undefined) throw opts.throwLike;
        return reply;
      } finally {
        inflight.unmark("conv-err-stop");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({ compacted: false }),
    continueSession: async () => {
      throw new Error("continueSession unused in error-stop-notice tests");
    },
    rewindSession: async (_id, _head) => ({ file }),
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
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-err-stop-"));
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

describe("TUI 异常 stopReason notice（Bug 2）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("protocolError → notice 提示 turn 未成功（连接/模型故障可见）", async () => {
    const app = await mount({ stopReason: "protocolError" });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("连接或模型"), 8000);
    // Normal-completion text must not leak in.
    expect(app.setup.captureCharFrame()).not.toContain("验证通过");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094: protocolError + apiError → dedicated "API error (status): message"
  // text. The sibling protocolError (no apiError) above still uses the old
  // generic `turn 未成功结束` text → the upgrade is branched, not a replacement.
  test("protocolError + apiError → 专用 API error 文案（gateway 摘要可见）", async () => {
    const app = await mount({
      stopReason: "protocolError",
      apiError: {
        status: 404,
        message: "No active credentials for provider: 9router",
      },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("API error (404): No active credentials"),
      8000
    );
    // Old generic text must not leak in (the API-error branch must not be swallowed by it).
    expect(app.setup.captureCharFrame()).not.toContain("连接或模型");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094: when apiError has no status, omit the parenthesized prefix → "API error: msg".
  test("protocolError + apiError (no status) → API error: message 文案", async () => {
    const app = await mount({
      stopReason: "protocolError",
      apiError: { message: "no status payload" },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("API error: no status payload"),
      8000
    );

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("completed → 无异常 notice", async () => {
    const app = await mount({ stopReason: "completed" });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // fake bridge has no verify DTO → no `验证通过` ("verification passed") banner;
    // wait for the turn to settle (notice render surface stable), then assert the
    // error text is absent.
    await new Promise((r) => setTimeout(r, 1500));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain("连接或模型");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094: 4xx non-transient provider failures are not wrapped in
  // TransportRetryExhausted — they reject straight from run() into the app-layer
  // catch. SDK APIError shape ({status, message, error:{error:{message}}}) is
  // distilled by summarizeTransportCause on the catch side, landing on the same
  // `API error (status): <original>` text instead of
  // `turn 失败:[object Object]` ("turn failed: [object Object]").
  test("throw 路径 (4xx APIError shape) → API error 文案（服务商原文可见）", async () => {
    const app = await mount({
      stopReason: "completed",
      throwLike: Object.assign(new Error("404 Not Found"), {
        name: "APIError",
        status: 404,
        error: {
          type: "error",
          error: {
            type: "not_found_error",
            message: "No active credentials for provider: fakeprov",
          },
        },
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("API error (404): No active credentials"),
      8000
    );
    // Old throw-path text must not leak in.
    expect(app.setup.captureCharFrame()).not.toContain("turn 失败");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // Hub-local validation errors (ValidationError without status) must not
  // impersonate an API error — only distilled results carrying an HTTP status
  // set apiError and take the API-error text; no status → apiError unset → the
  // notice branch falls back to the generic `turn 未成功结束` ("turn did not end
  // successfully") text (the catch-side `turn 失败` / "turn failed" is a
  // transitional frame, ultimately replaced by the generic notice — same durable
  // behavior as the pre-ADR-0094 throw path).
  test("throw 路径 (无 status 的本地 Error) → 通用 turn 未成功文案，不冒充 API error", async () => {
    const app = await mount({
      stopReason: "completed",
      throwLike: Object.assign(new Error("message text must be non-empty"), {
        name: "ValidationError",
      }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("turn 未成功结束（protocolError）"),
      8000
    );
    expect(app.setup.captureCharFrame()).not.toContain("API error");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("timeout → 同样落入异常 notice", async () => {
    const app = await mount({ stopReason: "timeout" });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("连接或模型"), 8000);

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监听", () => {
    process.off("unhandledRejection", listener);
  });
});
