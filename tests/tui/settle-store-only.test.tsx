/** @jsxImportSource @opentui/react */
/**
 * tests/tui/settle-store-only.test.tsx
 *
 * 出处: specs/interrupt-frozen-prefix-keep.md invariant 2 + input-contract 表
 * 「TUI settle」行（specs/interrupt-frozen-prefix-keep.md / ADR-0108）。
 *
 * 钉住的不变式：SSOT 在 closeout（store），不在 TUI overlay。
 *   1. overlay 空、store 有 freeze prefix → settle 后墙画 store（prefix 看得见）；
 *   2. 不得用 overlay 残稿（tailRaw，已被 harness 丢弃）覆盖 store ——
 *      settle 后墙上永不出现流式期间画过的残尾；
 *   3. `finally` 卸 draft（app.tsx draft.reset/setStreamDraft(null)）早于
 *      `turnFinished` 换快照（loadSessionFile）：最终帧以快照为准，
 *      已卸 draft 不会被写回历史（延迟刷新窗口后仍无残尾）。
 *   4. 无 prefix 盘（store 仅 user+interrupt）→ settle 后墙不画任何假 assistant。
 *
 * 装配沿用 interrupt-notice.test.tsx 的 fake-bridge 纪律：本测只认证 app 层
 * settle 的墙渲染映射（overlay 卸载 + 快照接管）；harness closeout 的
 * prefix commit 本身由 tests/harness（SC1/SC2）钉死，与本面解耦。
 * 流式期间先 assert 残尾**曾**上屏，使 settle 后的 not.toContain 非空洞。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

/** 流式期间画过、但 store 里没有的残尾标记（tailRaw 替身）。纯 ASCII：
 *  墙上 pangu 会在 CJK 与拉丁之间插空格，混排标记会破坏 includes 断言。 */
const TAIL_MARK = "GrowingTailX9";
/** harness closeout 已 commit 进 store 的钉住前缀（prefixRaw 替身）。 */
const PREFIX_TEXT = "KeptPrefixA7 pinned block";

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

interface SettleBridgeOptions {
  /** store（loadSessionFile）里是否有 assistant(prefix)：
   *  true = SC1 形状（user + assistant(prefix) + interrupt）；
   *  false = SC2 形状（user + interrupt，无 assistant）。 */
  readonly persistPrefix: boolean;
  /** loadSessionFile 延迟：放大「finally 卸 draft 早于快照替换」的竞争窗口。 */
  readonly loadDelayMs?: number;
}

/**
 * fake bridge：postMessage 期间经 onStream 推 text_delta（prefix + tail 两段，
 * 与真实 draft 累积路径同源），随后按 closeout 形状落盘 —— store 只含 prefix，
 * tail 被 harness 丢弃。cancelled + interrupted=true。
 */
function settleBridge(opts: SettleBridgeOptions): TuiBridge {
  const inflight = createInflightRegistry();
  const now = new Date().toISOString();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-settle",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: now,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "打断前的问题" }],
      },
      ...(opts.persistPrefix
        ? [
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: PREFIX_TEXT }],
            },
          ]
        : []),
      {
        role: "system" as const,
        content: [{ type: "text" as const, text: "Interrupted by user." }],
      },
    ],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    checkpoints: [],
  };
  const reply: TuiPostResult = {
    conversationId: "conv-settle",
    finalText: "",
    stopReason: "cancelled",
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
    interrupted: true,
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-settle",
    postMessage: async ({ onStream }) => {
      inflight.mark("conv-settle");
      try {
        const emit = (event: HarnessStreamEvent): void => {
          onStream?.(event);
        };
        emit({ type: "text_delta", text: PREFIX_TEXT });
        // 让运行中帧至少渲染一次（残尾上屏依赖此窗口）。
        await new Promise((r) => setTimeout(r, 80));
        emit({ type: "text_delta", text: `\n\n${TAIL_MARK}` });
        await new Promise((r) => setTimeout(r, 250));
        return reply;
      } finally {
        inflight.unmark("conv-settle");
      }
    },
    listSessions: async () => [],
    loadSessionFile: async () => {
      if (opts.loadDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs));
      }
      return file;
    },
    compactSession: async () => ({ compacted: false }),
    continueSession: async () => {
      throw new Error("continueSession unused in settle tests");
    },
    rewindSession: async (id) => {
      void id;
      return file;
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

async function mount(opts: SettleBridgeOptions): Promise<{
  setup: TestRendererSetup;
  destroy: () => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressEnter: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-settle-"));
  const bridge = settleBridge(opts);
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
    { width: 90, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
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

describe("TUI settle 只画 store（spec invariant 2 / T5）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("cancelled 有 prefix：流式画过残尾 → settle 后墙 = store（prefix+interrupt，无残尾）", async () => {
    const app = await mount({ persistPrefix: true, loadDelayMs: 300 });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    // 前提：残尾确实在 overlay 上屏过（否则 settle 后的 not.toContain 是空洞断言）。
    await untilFrame(app.setup, (f) => f.includes(TAIL_MARK));
    // settle：notice「已打断」出现 → 卸 draft + 快照替换均已完成。
    await untilFrame(app.setup, (f) => f.includes("已打断，checkpoint 已保存"));

    const frame = app.setup.captureCharFrame();
    // 墙画 store：prefix 正文与 interrupt 行都看得见。
    expect(frame).toContain(PREFIX_TEXT);
    expect(frame).toContain("Interrupted by user.");
    // overlay 残稿不覆盖 store、不写回历史。
    expect(frame).not.toContain(TAIL_MARK);

    // 竞争窗放大后的复检：快照晚到 300ms，卸 draft 早于换快照 —— 以快照为准，
    // 已卸 draft 不会在后续帧复活。
    await new Promise((r) => setTimeout(r, 600));
    await app.setup.renderOnce();
    const settled = app.setup.captureCharFrame();
    expect(settled).toContain(PREFIX_TEXT);
    expect(settled).not.toContain(TAIL_MARK);

    await new Promise((r) => setTimeout(r, 300));
    expect(rejections).toHaveLength(0);
    await app.destroy();
  }, 30_000);

  test("cancelled 无 prefix：settle 后墙只有 user+interrupt，不画假 assistant", async () => {
    const app = await mount({ persistPrefix: false });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes(TAIL_MARK));
    await untilFrame(app.setup, (f) => f.includes("已打断，checkpoint 已保存"));

    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("Interrupted by user.");
    expect(frame).not.toContain(TAIL_MARK);
    expect(frame).not.toContain(PREFIX_TEXT);

    await new Promise((r) => setTimeout(r, 300));
    expect(rejections).toHaveLength(0);
    await app.destroy();
  }, 30_000);

  // afterAll 而非伪 test：前面任一用例崩溃时钩子仍执行，避免监听器泄漏给
  // 同进程后续测试文件（review 遗留 Std-Low）。
  afterAll(() => {
    process.off("unhandledRejection", listener);
  });
});
