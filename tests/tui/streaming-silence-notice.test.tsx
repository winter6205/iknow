/** @jsxImportSource @opentui/react */
/**
 * tests/tui/streaming-silence-notice.test.tsx
 *
 * T2 (#transport-continue-persist): 流式臂静默 ~20s → notice 改文案为
 * 「仍在等待模型输出」;box 不自动消失(sticky 纪律);同一静默 episode 仅
 * 触发一次改写(streaming bytes 恢复 → 后续静默可再次触发一次);turn 结束
 * 行为不受影响(走既有 cancelled / completed / 异常 stopReason 收尾)。
 *
 * 用 fake bridge + 可注入 silence 阈值(默认 20_000 → 测试改 150ms)避免
 * 真实睡眠;fake bridge 不发任何 onStream 事件 → 模拟「连接建上但模型卡
 * 死不出字」场景;另外写一个 sibling 用例:onStream 在 ~一半阈值处发一个
 * text_delta(流式字节恢复)→ 后续仍静默,验证 timer 重置 + 同 episode 不
 * 重复 setNotice(spam 防护)。
 *
 * 不改 harness timers / idle 决策 —— 本测只钉 TUI notice 反馈层。
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

interface FakeBridgeOptions {
  /** bridge 在返回前等多少毫秒(模拟「连接建上但模型不出字」的静默窗口)。 */
  readonly waitMs: number;
  /**
   * 是否在 waitMs 中点发一个 text_delta(模拟「流恢复过一次」);true 用于
   * sibling 用例验证「恢复不清 notice」+ timer reset + 同 episode 不重复
   * setNotice(spam 防护)。
   */
  readonly pulseInMiddle?: boolean;
  /**
   * sibling 用例可观察的 pulse 闩:bridge 发出 text_delta 后置 true,测试
   * 借此断定「pulse 已到达 app」,再断言 notice 未被恢复事件误清。
   */
  readonly pulseLatch?: { value: boolean };
  readonly stopReason: TuiPostResult["stopReason"];
}

const SILENCE_NOTICE_LINE = "仍在等待模型输出";

function fakeBridge(opts: FakeBridgeOptions): TuiBridge {
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
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-silence",
    postMessage: async ({ onStream }) => {
      inflight.mark("conv-silence");
      try {
        // pulseInMiddle: 在 waitMs 中点发一个 text_delta(流式字节恢复)
        // → 断言面:notice 不被恢复事件清掉(spurious clear),timer 被重置。
        if (opts.pulseInMiddle === true) {
          await new Promise((r) => setTimeout(r, Math.floor(opts.waitMs / 2)));
          const pulse: HarnessStreamEvent = {
            type: "text_delta",
            text: "hi",
          };
          onStream?.(pulse);
          if (opts.pulseLatch !== undefined) opts.pulseLatch.value = true;
          await new Promise((r) => setTimeout(r, opts.waitMs / 2));
        } else {
          await new Promise((r) => setTimeout(r, opts.waitMs));
        }
        return reply;
      } finally {
        inflight.unmark("conv-silence");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({ compacted: false }),
    continueSession: async () => {
      throw new Error(
        "continueSession unused in streaming-silence-notice tests"
      );
    },
    rewindSession: async (_id, _head) => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => [],
  };
  return bridge;
}

async function mount(opts: {
  readonly bridgeOpts: FakeBridgeOptions;
  readonly streamingSilenceNoticeMs: number;
}): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-silence-"));
  const bridge = fakeBridge(opts.bridgeOpts);
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

  test("流式臂 ~20s 无事件 → notice 改写为「仍在等待」（sticky，不自动消失）", async () => {
    // silence 阈值 = 150ms;bridge 等 1000ms 不发任何事件 → 等够时间,
    // silence notice 必出现。turn 完成后(bridge 200ms 内返回 completed)
    // → 异常 stopReason 收尾不命中,completed 走 setNotice(undefined) 清
    // 掉本轮 notice。
    const app = await mount({
      bridgeOpts: { waitMs: 1000, stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // 等 silence timer 触发 + notice 渲染
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 4000);

    // box 必须仍在(不自动消失),且 box 内含「仍在等待」行
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // 再等一段远超阈值的时间:无 TTL → box 不应自动消失
    await new Promise((r) => setTimeout(r, 800));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // 静默期不应触发 unhandled rejection / 控制台污染
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("流式字节恢复不清 notice，静默再发生仍只改一次文案（不 spam）", async () => {
    // 时间线(阈值 200ms):
    //   0ms    turn 发起
    //   200ms  silence timer 到期 → notice「仍在等待」
    //   400ms  bridge 发 text_delta(流式字节恢复)→ onStream 重置 timer
    //   400ms+ 再次静默 → timer 再次到期(可重发同文案)
    //   900ms  bridge 返回 completed → 既有 completed 收尾清 notice
    // 断言面:(a) pulse 到达后 notice 未被「恢复」事件误清(spurious
    // clear);(b) 恢复后的静默期 box 仍在(下一 episode 仍可见);(c)
    // 无 unhandled rejection(timer 生命周期干净)。
    const pulseLatch = { value: false };
    const app = await mount({
      bridgeOpts: {
        waitMs: 800,
        pulseInMiddle: true,
        pulseLatch,
        stopReason: "completed",
      },
      streamingSilenceNoticeMs: 200,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 4000);

    // 等 bridge 确认已发出 text_delta。
    const latchStart = Date.now();
    while (!pulseLatch.value && Date.now() - latchStart < 4000) {
      await new Promise((r) => setTimeout(r, 50));
      await app.setup.renderOnce();
    }
    expect(pulseLatch.value).toBe(true);

    // (a) 流恢复后 notice 仍在:onStream 重置 timer 但**不**清 notice。
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // (b) 恢复后再度静默 → 下一次 episode 仍会给出「仍在等待」(box 未
    // 被恢复事件吞掉,且新 episode 可重发)。bridge 的 400ms 后半段
    // 静默足够跨过 200ms 阈值。
    await new Promise((r) => setTimeout(r, 300));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("turn 正常完成 → silence notice 不抢 turn-end 的 completed 收尾", async () => {
    // waitMs 短(100ms)远小于 silence 阈值(150ms)→ silence timer 还没
    // 触发,bridge 已返回 completed;走既有的 completed/maxTurns 收尾:
    // notice(undefined),无 sticky 残留。验证:本测不出现「仍在等待」
    // 假阳性(说明阈值语义正确,不等阈值就发)。
    const app = await mount({
      bridgeOpts: { waitMs: 50, stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await new Promise((r) => setTimeout(r, 600));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监听", () => {
    process.off("unhandledRejection", listener);
  });
});
