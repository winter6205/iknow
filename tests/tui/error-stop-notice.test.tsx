/** @jsxImportSource @opentui/react */
/**
 * tests/tui/error-stop-notice.test.tsx
 *
 * Bug（2026-09-07）：模型 429/网络类故障走 loop-engine 的静默路径 ——
 * TransportRetryExhaustedError 被压平成 stopReason:"protocolError" 的正常
 * RunResult（loop-engine.ts modelStop），finalText 为空，TUI runTurnOnce 的
 * notice 分支只覆盖 throw 路径与 cancelled → 一轮静默结束，UI 毫无反馈。
 *
 * 修复：非 completed / 非 cancelled / 非 maxTurns 的异常 stopReason 落
 * notice（复用 cancelled 同一渲染面）。maxTurns 已有专属完成反馈（验证行
 * 「验证通过（N 轮）」），不并入本映射。
 *
 * ADR-0094 SC4-SC5: transport 失败时 bridge 透传 apiError;protocolError +
 * apiError 走专用文案「API error (status): message」,让网关侧信息可见。
 * sibling 用例:protocolError 无 apiError → 仍保留旧「turn 未成功结束」文案,
 * 表明升级是分支化的、不替换通用文案。
 *
 * 测法与 interrupt-notice.test.tsx 同模式：fake bridge 注入已解析的
 * TuiPostResult，只钉 app 层 notice 映射；wire 产生与透传分别在 hub /
 * hub-bridge 层钉死。
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
  /** ADR-0094 SC4-SC5: 模拟 transport 失败摘要;undefined = 走原通用文案。 */
  readonly apiError?: { readonly status?: number; readonly message: string };
  /** 4xx 非瞬态失败走 run() reject 抛到这里(ADR-0094 实测补刀);设了就 reject。 */
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
    rewindSession: async (_id, _head) => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => [],
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
    // 正常完成文案不得误现。
    expect(app.setup.captureCharFrame()).not.toContain("验证通过");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094 SC4-SC5: protocolError + apiError → 专用文案「API error
  // (status): message」。sibling 上面的 protocolError(无 apiError) 仍走
  // 旧「turn 未成功结束」通用文案 → 升级是分支化的、不替换通用文案。
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
    // 旧通用文案不得误现(避免 API error 分支被通用文案吞掉)。
    expect(app.setup.captureCharFrame()).not.toContain("连接或模型");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094 SC4-SC5: apiError 无 status 时不带前缀括号,落到 "API error: msg"。
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
    // fake bridge 无 verify DTO → 无「验证通过」banner；等 turn 收尾
    // (notice 渲染面稳定)后断言异常文案不出现。
    await new Promise((r) => setTimeout(r, 1500));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain("连接或模型");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // ADR-0094 实测补刀: 4xx 非瞬态供应商失败不包 TransportRetryExhausted,
  // 从 run() reject 直达 app 层 catch。SDK APIError 形状({status, message,
  // error:{error:{message}}}) → catch 侧 summarizeTransportCause 提炼,
  // 同样落「API error (status): 原文」文案,而不是「turn 失败:[object Object]」。
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
    // throw 路径旧文案不得误现。
    expect(app.setup.captureCharFrame()).not.toContain("turn 失败");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  // repair (code-review Spec Low): hub 本地校验错误（ValidationError 无
  // status）不冒充 API error —— 只有带 HTTP status 的提炼结果才置 apiError
  // 并走 API error 文案；无 status → apiError 不置位 → notice 分支落回既有
  // 「turn 未成功结束」通用文案（catch 侧「turn 失败」为过渡帧，最终被通用
  // notice 覆盖，与 pre-ADR-0094 throw 路径 durable 行为一致）。
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
