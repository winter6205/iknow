/** @jsxImportSource @opentui/react */
/**
 * tests/tui/interrupt-notice.test.tsx
 *
 * B1: Ctrl+C 打断反馈 —— app.tsx runTurnOnce 的 notice 双分支断言。
 *
 * 用 fake bridge 注入已解析的 TuiPostResult(interrupted=true/false),直接驱动
 * runTurnOnce 的 notice 呈现:
 *   - interrupted === true  → notice「已打断，checkpoint 已保存」
 *   - interrupted === false → notice「已打断（无新内容，未落 checkpoint）」
 *
 * 为什么 fake bridge 而非真实 bridge + Ctrl+C 键序列:
 *   TUI 的打断键序列(提交 turn → Ctrl+C → abort → cancelled 落盘)涉及时序
 *   (delayMs / abort 竞态),用真实 bridge 断言「interrupted 双分支文案」会把
 *   时序噪声带进通知文案测试;而 `interrupted` 的 wire 产生已在 hub 层
 *   (tests/session-api/hub.test.ts B1 用例)与 hub-bridge 透传(既有
 *   hub-bridge.test.ts 模式)分别钉死。本测只钉 app 层的 notice 映射。
 *
 * fake bridge 需满足 TuiApp 全部调用面(listSessions / ensureSession /
 * postMessage / loadSessionFile / compactSession / rewindSession /
 * inflight / contextWindow)。消息渲染走 loadSessionFile 返回的空文件
 * (turnFinished 落盘刷新),notice 是唯一断言面。
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
  readonly interrupted: boolean;
  /** cancelled + delta>0 → 落盘含 checkpoint;delta=0 → 空文件。 */
  readonly persistCheckpoint: boolean;
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
    // cancelled 时 hub 一定带 interrupted;completed 走 undefined(字段缺席)。
    ...(opts.stopReason === "cancelled"
      ? { interrupted: opts.interrupted }
      : {}),
  };
  const bridge: TuiBridge = {
    hub: undefined as never, // 本测不消费 hub
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-b1",
    postMessage: async () => {
      inflight.mark("conv-b1");
      try {
        await new Promise((r) => setTimeout(r, 20));
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
      // 返回未修改文件(TuiApp 未在 rewind 分支;满足类型面即可)。
      void id;
      return file;
    },
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
      // 预热 + 清空(与 app.test.tsx 同模式)。
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
    // false 分支文案不得误现。
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
    // true 分支文案不得误现。
    expect(app.setup.captureCharFrame()).not.toContain("checkpoint 已保存");

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监探", () => {
    process.off("unhandledRejection", listener);
  });
});
