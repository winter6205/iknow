/** @jsxImportSource @opentui/react */
/**
 * tests/tui/compact-panel-lifecycle.test.tsx
 *
 * compact 进度面板的 **app 级生命周期**测试（bun:test）。
 *
 * 与 `compact-progress.test.tsx`（纯函数 + 组件 smoke）互补：那份测的是
 * 归约与渲染，这份测的是 **app.tsx 的接线契约** —— 面板何时被建立、何时被
 * 卸载。存在的直接原因：Spec review High —— 面板卸载要靠 HOLD_MS timer，
 * 而 timer 原先只在手动路径的 `settleCompactPanelFor` 里武装，turn 内
 * auto-compact 的终态事件直接把 `terminal` 置位却不武装 timer，导致
 * `✓ done` 面板永久挂在屏上并持续顶高 chrome 行账（+7 行）。
 *
 * 覆盖：
 *  1. turn 内 compaction_completed → 面板出现 → 终态后 HOLD_MS 内卸载
 *     （High 回归防线：不卸载即永久残留）；
 *  2. turn 内 compaction_started 后 turn 结束、无终态事件 → finally 强扫
 *     立即卸载（plan D3.5 的「漏 settle 不留伪在途」）。
 */
import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import type { CompactReason } from "../../src/harness/compress/index.js";
import { COMPACT_HOLD_MS } from "../../src/tui/compact-progress.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/** 帧等待：mockInput 字节经 stdin 异步解析，需轮询 renderOnce。 */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout ${label}:\n${setup.captureCharFrame()}`);
}

/** 轮询直到断言成立（面板卸载是异步的：hold timer 到点后才消失）。 */
async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
}

/**
 * mount 一个 TuiApp，stub 模型在 turns 的流式臂里发给定事件序列
 * （`streamEventsByStep` 是 stub-model 的既有缝，max-turns / hub 测试同款用法）。
 */
async function mountWithTurnEvents(
  events: ReadonlyArray<HarnessStreamEvent>
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-compact-life-"));
  const deps = makeDeps([assistantResult({ texts: ["ok"] })], {
    streamEventsByStep: [events],
  });
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps,
    inflight: createInflightRegistry(),
  });
  return mountWithBridge(bridge, dataDir);
}

/** 手动路径：把 bridge.compactSession 换成给定实现（包一层真 bridge）。 */
async function mountWithCompactSession(
  result:
    { readonly compacted: boolean; readonly reason: CompactReason } | Error
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-compact-life-"));
  const inner = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    inflight: createInflightRegistry(),
  });
  const bridge: typeof inner = {
    ...inner,
    compactSession: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return mountWithBridge(bridge, dataDir);
}

async function mountWithBridge(
  bridge: ReturnType<typeof createTuiBridge>,
  dataDir: string
): Promise<DrivenApp> {
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

describe("compact 面板 app 级生命周期（Spec review High 回归防线）", () => {
  test("turn 内 compaction_completed：面板出现，终态后 HOLD_MS 内自动卸载（不永久残留）", async () => {
    const app = await mountWithTurnEvents([
      { type: "compaction_started", droppedCount: 5 },
      { type: "compaction_completed", summaryLen: 120, durationMs: 800 },
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // 面板出现（turn 内 auto-compact 此前对用户完全静默，这是首个可见化）。
    await untilFrame(app.setup, (f) => f.includes("Compacting"), 8000, "panel");
    // 终态：done 状态行可见（✓ + done）。
    await untilFrame(
      app.setup,
      (f) => f.includes("✓") && f.includes("done"),
      8000,
      "terminal"
    );

    // **关键断言**：HOLD_MS 之后面板必须消失。修复前 turn 路径不武装 timer，
    // 这一步会超时（面板永久挂屏 + chrome 行账永久 +7）。
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      COMPACT_HOLD_MS + 6000,
      "panel-unmount"
    );

    await app.destroy();
  }, 30_000);

  test("turn 内 compaction_started 后无终态事件 → turn finally 强扫，终帧不留面板（不留伪在途）", async () => {
    const app = await mountWithTurnEvents([
      { type: "compaction_started", droppedCount: 3 },
      // 故意不发 completed / failed / cancelled：模拟 reactive 早返回 /
      // 事件被吞咽的「缺终态」路径。
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // 面板的建立与 finally 强扫都发生在同一个 turn 内，帧上可能一闪而过 ——
    // 契约是**终帧**不留面板，故断言 turn 结束后的稳定帧（修复前：面板带
    // `◐ Ns · 3 messages folded` 永久残留，本断言失败）。
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "answer");
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      6000,
      "sweep-unmount"
    );

    await app.destroy();
  }, 30_000);

  test("手动 /compact no-op（compacted:false）→ 面板清除，不留伪造 done（验收 9）", async () => {
    const app = await mountWithCompactSession({
      compacted: false,
      reason: "messages_too_few",
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 先建会话（draft 会走 guard 分支，不进 panel 路径）。
    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "seed");

    await app.typeText("/compact");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) => f.includes("Nothing to compact"),
      8000,
      "noop-notice"
    );
    // no-op = 压根没发生压缩：面板必须清掉（修复前的伪 done 会留 `✓ done`）。
    await until(
      () => {
        void app.setup.renderOnce();
        return !app.setup.captureCharFrame().includes("Compacting");
      },
      3000,
      "noop-immediate-clear"
    );

    await app.destroy();
  }, 30_000);

  test("手动 /compact 抛错 → 英文失败 notice（catch 路径 / 验收 16）", async () => {
    const app = await mountWithCompactSession(new Error("boom"));
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("ok"), 8000, "seed");

    await app.typeText("/compact");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) => f.includes("Compaction failed: boom"),
      8000,
      "failed-notice"
    );

    await app.destroy();
  }, 30_000);
});
