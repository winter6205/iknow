/** @jsxImportSource @opentui/react */
/**
 * tests/tui/memory-picker.test.tsx
 *
 * /memory 双开关面板：自动记忆 + Dream（Dream 依赖自动记忆）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { makeDeps } from "../cli/_fixtures.ts";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  applyMemoryPreviewToggle,
  committedMemoryPatch,
  memoryPickerRows,
  reduceMemoryPickerKey,
  seedMemoryPreview,
} from "../../src/tui/memory-picker.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";

const noKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  space: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
};

function key(patch: Partial<ModalKeyEvent["key"]>): ModalKeyEvent {
  return { input: "", key: { ...noKey, ...patch } };
}

describe("seedMemoryPreview", () => {
  test("缺省 → 自动记忆关、Dream 关", () => {
    expect(seedMemoryPreview(undefined)).toEqual({
      autoExtract: false,
      dream: false,
    });
  });

  test("Dream 开但自动记忆关 → Dream 显示为关", () => {
    expect(seedMemoryPreview({ autoExtract: false, dream: true })).toEqual({
      autoExtract: false,
      dream: false,
    });
  });

  test("两者都开 → 原样", () => {
    expect(seedMemoryPreview({ autoExtract: true, dream: true })).toEqual({
      autoExtract: true,
      dream: true,
    });
  });
});

describe("applyMemoryPreviewToggle", () => {
  test("翻转自动记忆 ON 时保留已有 Dream", () => {
    expect(
      applyMemoryPreviewToggle(
        { autoExtract: false, dream: false },
        "autoExtract"
      )
    ).toEqual({ autoExtract: true, dream: false });
  });

  test("关闭自动记忆时 Dream 一并关闭", () => {
    expect(
      applyMemoryPreviewToggle(
        { autoExtract: true, dream: true },
        "autoExtract"
      )
    ).toEqual({ autoExtract: false, dream: false });
  });

  test("自动记忆关时翻转 Dream 无效果", () => {
    expect(
      applyMemoryPreviewToggle({ autoExtract: false, dream: false }, "dream")
    ).toEqual({ autoExtract: false, dream: false });
  });

  test("自动记忆开时可以开关 Dream", () => {
    expect(
      applyMemoryPreviewToggle({ autoExtract: true, dream: false }, "dream")
    ).toEqual({ autoExtract: true, dream: true });
    expect(
      applyMemoryPreviewToggle({ autoExtract: true, dream: true }, "dream")
    ).toEqual({ autoExtract: true, dream: false });
  });
});

describe("committedMemoryPatch", () => {
  test("自动记忆关 → dream 必为 false", () => {
    expect(committedMemoryPatch({ autoExtract: false, dream: true })).toEqual({
      autoExtract: false,
      dream: false,
    });
  });

  test("自动记忆开 → 保留 dream", () => {
    expect(committedMemoryPatch({ autoExtract: true, dream: true })).toEqual({
      autoExtract: true,
      dream: true,
    });
  });
});

describe("reduceMemoryPickerKey", () => {
  test("↓ 从自动记忆移到 Dream（clamp 0..1）", () => {
    expect(
      reduceMemoryPickerKey(key({ downArrow: true }), { focusedIndex: 0 })
    ).toEqual({ type: "move", index: 1 });
  });

  test("↓ 已在 Dream → clamp 1", () => {
    expect(
      reduceMemoryPickerKey(key({ downArrow: true }), { focusedIndex: 1 })
    ).toEqual({ type: "move", index: 1 });
  });

  test("↑ 从 Dream 回到自动记忆", () => {
    expect(
      reduceMemoryPickerKey(key({ upArrow: true }), { focusedIndex: 1 })
    ).toEqual({ type: "move", index: 0 });
  });

  test("Space / Tab → toggle 当前行", () => {
    expect(
      reduceMemoryPickerKey(key({ space: true }), { focusedIndex: 0 })
    ).toEqual({
      type: "toggle",
    });
    expect(
      reduceMemoryPickerKey(key({ tab: true }), { focusedIndex: 1 })
    ).toEqual({
      type: "toggle",
    });
  });

  test("Enter → fix；Esc → commit", () => {
    expect(
      reduceMemoryPickerKey(key({ return: true }), { focusedIndex: 0 })
    ).toEqual({ type: "fix" });
    expect(
      reduceMemoryPickerKey(key({ escape: true }), { focusedIndex: 0 })
    ).toEqual({ type: "commit" });
  });

  test("ctrl/meta → ignore", () => {
    expect(
      reduceMemoryPickerKey(
        { input: "c", key: { ...noKey, ctrl: true } },
        { focusedIndex: 0 }
      )
    ).toEqual({ type: "ignore" });
  });
});

describe("memoryPickerRows", () => {
  test("6 行 = 边框 2 + 标题/两行开关/键位提示 4", () => {
    expect(memoryPickerRows()).toBe(6);
  });
});

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
  throw new Error(
    `untilFrame timeout (${label}):\n${setup.captureCharFrame()}`
  );
}

describe("memory-picker app 集成", () => {
  test("/memory 打开面板：标题「记忆开关」+ 自动记忆 OFF + Dream 锁定", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-mem-"));
    const bridge = createTuiBridge({
      dataDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={dataDir}
        permissionMode={createPermissionModeContext("default")}
        sessionGrants={createSessionGrants()}
      />,
      { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    await new Promise((r) => setTimeout(r, 500));
    await setup.waitForVisualIdle();
    await setup.waitForVisualIdle();
    setup.mockInput.pressKey("/");
    await new Promise((r) => setTimeout(r, 100));
    await setup.renderOnce();
    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
      await new Promise((r) => setTimeout(r, 30));
    }
    for (const ch of "/memory") {
      setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 100));
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 100));
    await setup.renderOnce();
    const frame = await untilFrame(
      setup,
      (f) => f.includes("记忆开关"),
      8000,
      "open"
    );
    expect(frame).toContain("自动记忆");
    expect(frame).toContain("Dream");
    expect(frame).toContain("OFF");
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }, 30_000);
});
