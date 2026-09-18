/** @jsxImportSource @opentui/react */
/**
 * tests/tui/streaming-silence-notice.test.tsx
 *
 * T2 (#transport-continue-persist): 流式臂静默 ~20s → notice 改文案为
 * 「Waiting for model output」(英文,与 sticky notice 的既有约定一致);
 * box 不自动消失(sticky 纪律);同一静默 episode 仅触发一次改写
 * (streaming bytes 恢复 → 后续静默可再次触发一次);turn 结束行为不受影响
 * (走既有 cancelled / completed / 异常 stopReason 收尾)。
 *
 * 相位门(本文件后半):「无流字节」只在**模型相位**是异常信号。工具执行期
 * (含权限 / ask 等待)harness 按设计不发流事件 —— 该相位不得落等待文案;
 * 成功收尾若等待文案仍在屏(未被更明确的来源覆盖)则清除,不留过期提示。
 *
 * 用 fake bridge + 可注入 silence 阈值(默认 20_000 → 测试改 150ms)避免
 * 真实睡眠;fake bridge 不发任何 onStream 事件 → 模拟「连接建上但模型卡
 * 死不出字」场景;另外写一个 sibling 用例:回合中途发一个 text_delta
 * (流式字节恢复)→ 后续仍静默,验证 timer 重置 + 同 episode 不重复
 * setNotice(spam 防护)。
 *
 * 回合收尾时机由 release 闩显式控制,不按墙钟 —— 断言全部落在「回合在飞」
 * 区间内,负载只会加长观察窗,不会把收尾塞进两步断言之间。固定 waitMs 在
 * 负载下会把待观察窗口吃掉(本文件此前 flaky 的根因)。
 *
 * 不改 harness timers / idle 决策 —— 本测只钉 TUI notice 反馈层。
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
 * 回合控制面:bridge 把 onStream 交给测试,事件时序与收尾时机全部由测试
 * 驱动(不按墙钟)。负载只会**加长**观察窗 —— 收尾不会挤进两步断言之间,
 * 这是本文件此前 flaky 的根因(固定 waitMs 圈窗,负载下窗口被吃掉)。
 */
interface TurnControl {
  /** 回合已进入 postMessage(事件通道就绪);控制调用前先 await 它。 */
  readonly started: Promise<void>;
  /** 发一个 text_delta(流式字节恢复)。 */
  pulse(): void;
  /** 发 tool_call_start(模型交出 tool_use → 进工具相位,此后不产流事件)。 */
  toolStart(): void;
  /** 发 agent_status(工具批收口、下一轮模型调用将起 → 回模型相位)。 */
  agentStatus(): void;
  /** 释放回合,令 postMessage 返回 stopReason(收尾走既有 completed 路径)。 */
  release(): void;
}

interface FakeBridgeOptions {
  readonly stopReason: TuiPostResult["stopReason"];
  /**
   * true:postMessage 立即返回,不等 release —— 钉「回合短于阈值时不得
   * 落文案」(阈值语义:不等窗口就发是错的)。
   */
  readonly returnImmediately?: boolean;
}

/** tool_call_start 的工具 id(相位门用例共用)。 */
const TOOL_USE_ID = "toolu_silence_1";

/** 模型调用边界事件(工具批收口、重新进入模型相位)。 */
function agentStatusEvent(): HarnessStreamEvent {
  return { type: "agent_status", lastTool: "bash", openTodoLines: [] };
}

/** 静默等待文案的稳定子串(英文文案,单一渲染面 STREAMING_SILENCE_NOTICE_LINES)。 */
const SILENCE_NOTICE_LINE = "Waiting for model output";

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
  // 事件与收尾一律由测试经 control 驱动:onStream 在 postMessage 进入时
  // 捕获,release 前回合恒「在飞」。
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
    getCapacity: () => 15,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
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
    // silence 阈值 = 150ms;回合由 release 闩持有(不按墙钟)→ 观察窗
    // 无限长,负载只会加长它。钉「sticky = 不因 TTL 自行消失」;回合收尾
    // 清除等待文案由下方独立用例钉(过程性提示,与异常停 sticky 分流)。
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    // 等 silence timer 触发 + notice 渲染
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 4000);

    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // 再等一段远超阈值的时间:turn 仍在飞(未 release) → box 不应自动消失
    await new Promise((r) => setTimeout(r, 800));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // 静默期不应触发 unhandled rejection / 控制台污染
    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("流式字节恢复不清 notice，静默再发生仍只改一次文案（不 spam）", async () => {
    // 时间线(阈值 200ms,回合由 release 闩持有):
    //   0ms    turn 发起
    //   200ms  silence timer 到期 → notice「仍在等待」
    //   之后   control.pulse() 发 text_delta(流式字节恢复)→ onStream 重置
    //          timer,但**不**清 notice
    //   再之后 新静默窗到期 → 下一 episode 仍可见等待文案
    // 断言面:(a) pulse 到达后 notice 未被「恢复」事件误清(spurious
    // clear);(b) 恢复后的静默期 box 仍在;(c) 无 unhandled rejection
    // (timer 生命周期干净)。回合不被 release → 收尾清理不会与断言竞争。
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 200,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 4000);

    // (a) 流恢复后 notice 仍在:onStream 重置 timer 但**不**清 notice。
    // pulse() 内部同步调用 onStream → 返回时事件已达 app,无需闩。
    app.control.pulse();
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    // (b) 恢复后再度静默(≥ 2× 阈值) → 等待文案仍可见(box 未被恢复事件
    // 吞掉,下一 episode 仍展示)。回合未 release → 断言只会被负载延后,
    // 不会被收尾清掉。
    await new Promise((r) => setTimeout(r, 500));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("turn 正常完成 → silence notice 不抢 turn-end 的 completed 收尾", async () => {
    // returnImmediately:回合在阈值(150ms)前就 completed → timer 在
    // arm 后几个 microtask 内即被收尾清除,不存在「timer 先响还是回合先完」
    // 的墙钟竞争(该竞争正是旧 waitMs 版本 flaky 的来源)。验证本测不出现
    // 假阳性「仍在等待」(阈值语义正确,不等阈值就发)。
    const app = await mount({
      bridgeOpts: { stopReason: "completed", returnImmediately: true },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // 睡满 4× 阈值:若 timer 未被收尾清掉,早已触发并上屏。
    await new Promise((r) => setTimeout(r, 600));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("工具相位跨静默阈值 → 不落等待文案；回到模型相位后仍会给出提示", async () => {
    // 回归钉:harness 在工具执行期不产任何流事件(设计使然),此前该相位
    // 静默 ~20s 就会误报「Waiting for model output / Check your network」。
    // 相位由 control 显式驱动(阈值 150ms):toolStart() 进工具相位(回合
    // 由 release 持有,相位保持) → 睡过 4+ 个阈值周期不落文案 →
    // agentStatus() 回模型相位 → 下一个完整窗给出等待文案。
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    app.control.toolStart();
    // 工具相位:跨 4+ 个阈值周期,不落等待文案。
    await new Promise((r) => setTimeout(r, 650));
    await app.setup.renderOnce();
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);

    // 回模型相位(agent_status)后仍静默 → 下一个完整窗给出等待文案:
    // 抑制是相位性的,不是整轮关闭。
    app.control.agentStatus();
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    expect(rejections).toHaveLength(0);

    app.control.release();
    await app.setup.renderOnce();
    await app.destroy();
  }, 30_000);

  test("成功收尾清除等待文案（过程性提示，不残留过期网络提示）", async () => {
    // 阈值 150ms:等待文案先上屏(回合由 release 持有,必然等到) → release
    // 令回合以 completed 收尾 → 同 retry 进度的既有处置,过程性文案随成功
    // 收尾清除。上屏与收尾不再共用墙钟窗口 —— 负载不会把收尾塞进两步断言
    // 之间(旧 waitMs 版本的 flaky 根因)。
    const app = await mount({
      bridgeOpts: { stopReason: "completed" },
      streamingSilenceNoticeMs: 150,
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await app.control.started;
    await untilFrame(app.setup, (f) => f.includes(SILENCE_NOTICE_LINE), 8000);

    // 释放回合 → 收尾落地(清 timer + 成功收尾分支),等待文案须消失。
    app.control.release();
    await untilFrame(app.setup, (f) => !f.includes(SILENCE_NOTICE_LINE), 8000);
    expect(app.setup.captureCharFrame()).not.toContain(SILENCE_NOTICE_LINE);

    expect(rejections).toHaveLength(0);

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
