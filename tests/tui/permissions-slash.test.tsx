/** @jsxImportSource @opentui/react */
/**
 * `/permissions` at the TUI entry — T4 of plans/permission-axis-orthogonality.md.
 *
 * Why this test exists: `plan` was reachable only from the REPL, so the TUI
 * could *display* "Plan Mode" (modeLabel) but never enter it. The mode row and
 * the Shift+Tab wheel are deliberately untouched — `plan` is still not a wheel
 * station (harness/permission/modes.ts, harness/graph/mode.ts); it is entered
 * and left by explicit command.
 *
 * Three layers, mirroring tests/tui/graph-mode.test.tsx and tests/tui/fs-mode.test.tsx:
 *  1. vocabulary: the five hand-maintained touch points (union → VOCABULARY →
 *     helpLines → HINT_DESCRIPTIONS → dispatch) all know `/permissions`;
 *  2. application: `/permissions plan` flips the injected holder, `/permissions
 *     default` leaves it, and the mode row re-reads the holder (the mirror is
 *     unsubscribed — the same re-read the yolo and Shift+Tab paths do);
 *  3. SSOT: the TUI routes through the shared `applyPermissionsCommand`, so the
 *     TUI and the REPL cannot drift on the three-value parse.
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
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { PermissionModeContext } from "../../src/harness/permission/modes.js";
import {
  helpLines,
  parseTuiInput,
  slashHintLines,
  slashSuggestions,
} from "../../src/tui/slash.js";
import { modeRowBaseLabel } from "../../src/tui/app.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

describe("TUI 词表：/permissions", () => {
  test("parseTuiInput 认 /permissions（带参也命中同一命令）", () => {
    expect(parseTuiInput("/permissions")).toEqual({
      kind: "command",
      command: "permissions",
    });
    expect(parseTuiInput("/permissions plan")).toEqual({
      kind: "command",
      command: "permissions",
    });
  });

  test("/permissionsx 不误命中（无前缀假命中）", () => {
    expect(parseTuiInput("/permissionsx")).toEqual({
      kind: "unknown",
      raw: "/permissionsx",
    });
  });

  test('"/p" 前缀候选命中 permissions', () => {
    expect(slashSuggestions("/p")).toEqual([
      { kind: "command", command: "permissions" },
    ]);
  });

  test("helpLines 列出 /permissions 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/permissions");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test("hint 描述已登记（closed record 强制补齐的那一条）", () => {
    expect(slashHintLines(["permissions"])).toEqual([
      {
        command: "permissions",
        description: "权限模式（default|plan|full_auto）",
      },
    ]);
  });

  test("窄列也要区分 plan：/permissions plan 之后不能显示成 [def]", () => {
    // The narrow form ([def] / [auto] / [graph]) predates `plan` being
    // reachable here; a mode that says "def" while denying every write is a
    // false statement in the one place the label is always visible.
    expect(
      modeRowBaseLabel({ graphOn: false, permMode: "plan", cols: 39 })
    ).toBe("[plan]");
    expect(
      modeRowBaseLabel({ graphOn: false, permMode: "plan", cols: 80 })
    ).toBe("mode: Plan Mode");
  });
});

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressShiftTab: () => Promise<void>;
}

async function mountApp(opts: {
  readonly permissionMode: PermissionModeContext;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-perm-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
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

describe("TUI 装配：/permissions 翻 holder，模式行随之重读", () => {
  test("/permissions plan 进、/permissions default 出；模式行显示 Plan Mode", async () => {
    const permissionMode = createPermissionModeContext("default");
    const app = await mountApp({ permissionMode });
    try {
      expect(app.setup.captureCharFrame()).toContain("mode: Default");

      await app.typeText("/permissions plan");
      await app.pressEnter();
      expect(permissionMode.get()).toBe("plan");
      // The mirror is unsubscribed; the command path must re-read the holder
      // or the mode row keeps rendering the pre-entry label.
      expect(app.setup.captureCharFrame()).toContain("mode: Plan Mode");

      await app.typeText("/permissions default");
      await app.pressEnter();
      expect(permissionMode.get()).toBe("default");
      expect(app.setup.captureCharFrame()).toContain("mode: Default");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("/permissions 缺省 → 回显当前模式文案（共享层的 status 分支）", async () => {
    const permissionMode = createPermissionModeContext("full_auto");
    const app = await mountApp({ permissionMode });
    try {
      await app.typeText("/permissions");
      await app.pressEnter();
      expect(permissionMode.get()).toBe("full_auto");
      expect(app.setup.captureCharFrame()).toContain("权限模式: full_auto");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("/permissions nope → 用法文案，holder 不动", async () => {
    const permissionMode = createPermissionModeContext("default");
    const app = await mountApp({ permissionMode });
    try {
      await app.typeText("/permissions nope");
      await app.pressEnter();
      expect(permissionMode.get()).toBe("default");
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/Usage|\/permissions/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("Shift+Tab 仍不经过 plan（轮盘站位未变：plan → full_auto）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const app = await mountApp({ permissionMode });
    try {
      await app.typeText("/permissions plan");
      await app.pressEnter();
      expect(permissionMode.get()).toBe("plan");
      await app.pressShiftTab();
      expect(permissionMode.get()).toBe("full_auto");
      await app.pressShiftTab();
      expect(permissionMode.get()).toBe("default");
    } finally {
      app.destroy();
    }
  }, 30_000);
});
