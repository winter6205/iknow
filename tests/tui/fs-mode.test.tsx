/** @jsxImportSource @opentui/react */
/**
 * ADR-0092: `/config` TUI integration (filesystem isolation tier switching).
 *
 * Mirrors the DrivenApp shape of `tests/tui/graph-mode.test.tsx` (bun:test +
 * testRender), covering:
 *  1. `/config fs workspace` flips the holder to workspace and fires the
 *     onPersistFsMode callback (fire-and-forget);
 *  2. `/config status` echoes the current tier (no persist);
 *  3. `/config fs invalid` → usage text, holder untouched, no persist;
 *  4. holder absent → `未接线` ("not wired") notice, no throw;
 *  5. Shift+Tab leaves the fs holder alone (orthogonal to PermissionMode).
 *
 * Depends on `src/harness/sandbox/fs-mode.ts` (holder plus
 * `parseConfigCommand` / `applyFsModeCommand` / `formatFsModeStatus` /
 * `splitConfigArgs` + types / constants); without it the import fails — the
 * expected RED shared with `tests/config/fs-mode.test.ts`.
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
      // holder actually flipped.
      expect(fsMode.get()).toBe("workspace");
      // persist callback invoked once with the target tier.
      expect(persistCalls).toEqual(["workspace"]);
      // status text lands on screen (contains "workspace" + switch/next-session wording).
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
      expect(fsMode.get()).toBe("workspace"); // holder untouched
      expect(persistCalls).toBe(0); // status does not trigger persist
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
      expect(fsMode.get()).toBe("global"); // holder untouched
      expect(persistCalls).toBe(0);
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/Usage|\/config/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("holder 缺席 → notice「未接线」，不抛", async () => {
    const permissionMode = createPermissionModeContext("default");
    // No fsMode passed → props.fsMode absent.
    const app = await mountApp({ permissionMode });
    try {
      await app.typeText("/config fs workspace");
      await app.pressEnter();
      // No throw, no deadlock; screen carries the "not wired" semantics.
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
      expect(fsMode.get()).toBe("global"); // Shift+Tab never flips the fs holder
      await app.pressShiftTab();
      expect(fsMode.get()).toBe("global");
      expect(permissionMode.get()).toBe("default"); // cycling returns to default
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
      // holder still flips (command SSOT already applied); persist failure is caught by the UI.
      expect(fsMode.get()).toBe("workspace");
      // Screen lands "save failed / persist 失败" semantics.
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
    // Simulates the TUI: slashRemainder('/config fs workspace') → 'fs workspace'
    // → splitConfigArgs → ['fs', 'workspace']
    const args = splitConfigArgs("fs workspace");
    const res = applyFsModeCommand(ctx, args);
    expect(res.ok).toBe(true);
    expect(ctx.get()).toBe("workspace");
    expect(res.text).toMatch(/已切换|workspace|下一次/);
  });
});
