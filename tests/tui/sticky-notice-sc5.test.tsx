/** @jsxImportSource @opentui/react */
/**
 * tests/tui/sticky-notice-sc5.test.tsx
 *
 * spec `specs/transport-continue-persist.md` SC5 / 不变式 3：异常停 notice 是
 * **sticky** —— 在屏直到用户明确动作（关掉 / 发下一条消息），无 TTL 自动收回。
 *
 * 两条不变式（本文件是唯一钉它们的地方）：
 *  1. 无 TTL —— 跨过静默计时器多个周期后 notice 原样在屏；
 *  2. 只有用户明确动作（发下一条消息）清它，清除与「又跑完一轮」无因果。
 *
 * 计时注入：`streamingSilenceNoticeMs`（组件既有测试注入口）压到 150ms。
 * 该计时器是 turn 结束后仍可能触碰 notice 的定时源，周期缩到 150ms 后，
 * 任何「定时器把 notice 收回去 / 改写成等待文案」的回归都会在数百毫秒内
 * 暴露，无需真实秒级睡眠；测试再以 50ms 步长 pump 大量帧覆盖多个计时周期。
 *
 * 测法与 error-stop-notice.test.tsx 同模式：fake bridge 注入已解析的
 * TuiPostResult，只钉 app 层 notice 生命周期；wire 产生与透传在 hub 层钉死。
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

/** 异常停 notice 的稳定子串（abnormalStopNoticeLines → apiErrorNoticeLine）。 */
const ABNORMAL_NOTICE_NEEDLE = "API error (404)";
/** 流式静默 notice 的稳定子串（STREAMING_SILENCE_NOTICE_LINES）。 */
const SILENCE_NOTICE_NEEDLE = "Waiting for model output";
/**
 * 注入的静默阈值：~1/133 于默认 20s。turn 结束后仍可能触碰 notice 的定时源
 * 只有它，周期压到 150ms 才能用亚秒级观察窗覆盖多个计时周期。
 */
const INJECTED_SILENCE_MS = 150;
/**
 * sticky 存活观察窗：以 50ms 步长 pump 帧（非单次长睡），累计 ≥ 16 个注入
 * 阈值周期 —— 任何定时驱动的自动收回 / 文案改写都会落在窗内。
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

/** 多帧 pump：每步渲染一次，让任何挂着的定时器都有机会落地。 */
async function pumpFrames(setup: TestRendererSetup, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
    await setup.renderOnce();
  }
}

/** 单个 turn 的剧本；缺席字段走默认（等待 + 按 stopReason 收尾）。 */
interface TurnScript {
  readonly stopReason: TuiPostResult["stopReason"];
  readonly apiError?: { readonly status?: number; readonly message: string };
  /** 非空 → 该 turn 返回前阻塞于此 promise（模拟 turn 仍在飞）。 */
  readonly gate?: Promise<void>;
  /** 该 turn 进入 postMessage 时置位（测试据此断定 turn 已在飞）。 */
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
    rewindSession: async (_id, _head) => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => [],
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
      // mockInput 走 stdin 异步解析；连发过快会丢键。以输入行回显
      // (`❯ <text>`) 作落地判据，未落地则清空重打。
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
    // 阳性对照：注入的静默阈值确实在跑（turn 在飞时先落等待文案）。
    // 没有这一步，下面的存活窗可能因计时器根本没武装而空过。
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_NEEDLE), 4000);
    // 收尾通知（processChatLine 尾段的 turn 结算）完成后 notice 才落定。
    await untilFrame(
      app.setup,
      (f) => f.includes(ABNORMAL_NOTICE_NEEDLE),
      8000
    );

    // 存活窗内逐帧断言：任一帧丢失即失败（不是只看窗尾）。
    const start = Date.now();
    let pumped = 0;
    while (Date.now() - start < STICKY_SURVIVAL_WINDOW_MS) {
      await new Promise((r) => setTimeout(r, PUMP_STEP_MS));
      await app.setup.renderOnce();
      pumped += 1;
      const frame = app.setup.captureCharFrame();
      expect(frame).toContain(ABNORMAL_NOTICE_NEEDLE);
      // 静默计时器已在 turn 收尾 finally 里拆除：不得把异常停文案改写回
      // 「仍在等待」（sticky notice 的文案只由新的明确状态覆盖，不被过期
      // 计时器回头改）。
      expect(frame).not.toContain(SILENCE_NOTICE_NEEDLE);
    }
    // 观察窗确实覆盖了多个注入阈值周期（防止 pump 逻辑退化成空转）。
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

      // (a) 空闲期不自动消失：跨过 silence 默认阈值无意义的时间量后仍在屏。
      await pumpFrames(app.setup, 600);
      expect(app.setup.captureCharFrame()).toContain(ABNORMAL_NOTICE_NEEDLE);

      // (b) 光敲字（草稿）不算明确动作：notice 必须还在。
      await app.typeText("go2");
      expect(app.setup.captureCharFrame()).toContain(ABNORMAL_NOTICE_NEEDLE);

      // (c) 用户动作 = 提交。清除发生在动作当刻 —— 此刻第二轮仍被 gate 挡在
      // 飞行中，任何「靠时间 / 靠本轮收尾」的解释都不成立。
      await app.pressEnter();
      await until(() => secondTurnEntered.value, 8000, "second-turn-inflight");
      await app.setup.renderOnce();
      const inFlight = app.setup.captureCharFrame();
      expect(inFlight).not.toContain(ABNORMAL_NOTICE_NEEDLE);
      expect(inFlight).not.toContain(SILENCE_NOTICE_NEEDLE);

      // (d) 新一轮正常收尾不回填旧异常停文案（sticky 只到用户动作为止）。
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
