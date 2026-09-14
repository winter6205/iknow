/** @jsxImportSource @opentui/react */
/**
 * ADR-0092 / SC13: `/config` TUI 集成（filesystem isolation 档切换）。
 *
 * 镜像 `tests/tui/graph-mode.test.tsx` 的 DrivenApp 形态（bun:test +
 * testRender），覆盖：
 *  1. `/config fs workspace` 翻 holder 到 workspace，并触发 onPersistFsMode
 *     回调（fire-and-forget）；
 *  2. `/config status` 回显当前档（不触发 persist）；
 *  3. `/config fs invalid` → usage 文案，holder 不动，不触发 persist；
 *  4. holder 缺席 → notice「未接线」，不抛；
 *  5. Shift+Tab 不动 fs holder（与 PermissionMode 正交）。
 *
 * 该测试依赖 `src/harness/sandbox/fs-mode.ts`（T7 持有主体；T8 追加
 * `parseConfigCommand` / `applyFsModeCommand` / `formatFsModeStatus` /
 * `splitConfigArgs` + 类型 / 常量）落地，否则导入会失败——这是预期的
 * RED（与 `tests/config/fs-mode.test.ts` 同源）。T7 落地后 GREEN。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { PermissionModeContext } from "../../src/harness/permission/modes.js";
import {
  createFsModeContext,
  applyFsModeCommand,
  splitConfigArgs,
  type FsIsolationMode,
  type FsModeContext,
} from "../../src/harness/sandbox/fs-mode.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressShiftTab: () => Promise<void>;
}

async function mountApp(opts: {
  readonly permissionMode: PermissionModeContext;
  readonly fsMode?: FsModeContext;
  readonly onPersistFsMode?: (mode: FsIsolationMode) => Promise<void>;
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-fsmode-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })], {
      streamEventsByStep: opts.streamEventsByStep,
    }),
    inflight: createInflightRegistry(),
  });
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={opts.permissionMode}
      fsMode={opts.fsMode}
      onPersistFsMode={opts.onPersistFsMode}
      sessionGrants={createSessionGrants()}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    setup,
    destroy: () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      rmSync(dataDir, { recursive: true, force: true });
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
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressShiftTab: async () => {
      setup.mockInput.pressTab({ shift: true });
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
  };
}

describe("TUI 词表 + holder 接通：/config", () => {
  test("/config fs workspace 翻 holder + 触发 onPersistFsMode 回调", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    let persistCalls: FsIsolationMode[] = [];
    const onPersistFsMode = async (mode: FsIsolationMode) => {
      persistCalls.push(mode);
    };
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode,
    });
    try {
      await app.typeText("/config fs workspace");
      await app.pressEnter();
      // holder 真翻。
      expect(fsMode.get()).toBe("workspace");
      // persist 回调被调用一次，且参数 = 目标档。
      expect(persistCalls).toEqual(["workspace"]);
      // 状态文案落在屏上（含「workspace」+「已切换/下一次」语义词）。
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/workspace/);
      expect(frame).toMatch(/已切换|下一次/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("/config fs global 翻回 global + holder 同步", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("workspace");
    let persistCalls: FsIsolationMode[] = [];
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async (m) => {
        persistCalls.push(m);
      },
    });
    try {
      await app.typeText("/config fs global");
      await app.pressEnter();
      expect(fsMode.get()).toBe("global");
      expect(persistCalls).toEqual(["global"]);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("/config status 回显当前档（不触发 persist）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("workspace");
    let persistCalls = 0;
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async () => {
        persistCalls += 1;
      },
    });
    try {
      await app.typeText("/config status");
      await app.pressEnter();
      expect(fsMode.get()).toBe("workspace"); // holder 不动
      expect(persistCalls).toBe(0); // status 不触发 persist
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/workspace/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("/config fs invalid → usage 文案，holder 不动，不触发 persist", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    let persistCalls = 0;
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async () => {
        persistCalls += 1;
      },
    });
    try {
      await app.typeText("/config fs wrong");
      await app.pressEnter();
      expect(fsMode.get()).toBe("global"); // holder 不动
      expect(persistCalls).toBe(0);
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/Usage|\/config/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("holder 缺席 → notice「未接线」，不抛", async () => {
    const permissionMode = createPermissionModeContext("default");
    // 不传 fsMode → props.fsMode 缺席。
    const app = await mountApp({ permissionMode });
    try {
      await app.typeText("/config fs workspace");
      await app.pressEnter();
      // 不抛、不死锁，屏上含「未接线」语义。
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/未接线|未注入|未挂载/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("Shift+Tab 不动 fs holder（与 PermissionMode 正交）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({ permissionMode, fsMode });
    try {
      await app.pressShiftTab();
      expect(permissionMode.get()).toBe("full_auto");
      expect(fsMode.get()).toBe("global"); // fs holder 不被 Shift+Tab 翻
      await app.pressShiftTab();
      expect(fsMode.get()).toBe("global");
      expect(permissionMode.get()).toBe("default"); // 两态轮回到 default
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("persist 失败 → setNotice 落屏（fire-and-forget 不抛）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async () => {
        throw new Error("boom from persist");
      },
    });
    try {
      await app.typeText("/config fs workspace");
      await app.pressEnter();
      // holder 仍翻（命令 SSOT 已应用），persist 失败由 UI 兜底。
      expect(fsMode.get()).toBe("workspace");
      // 屏上落「保存失败 / persist 失败」语义。
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/失败|boom/);
    } finally {
      app.destroy();
    }
  }, 30_000);
});

describe("命令 SSOT 三函数（值域闭环）", () => {
  test("applyFsModeCommand 直接调用 = TUI `/config` 走的同一条路径", () => {
    const ctx = createFsModeContext("global");
    // 模拟 TUI:slashRemainder('/config fs workspace') → 'fs workspace'
    // → splitConfigArgs → ['fs', 'workspace']
    const args = splitConfigArgs("fs workspace");
    const res = applyFsModeCommand(ctx, args);
    expect(res.ok).toBe(true);
    expect(ctx.get()).toBe("workspace");
    expect(res.text).toMatch(/已切换|workspace|下一次/);
  });
});
