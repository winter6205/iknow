/** @jsxImportSource @opentui/react */
/**
 * ADR-0096 — `/config` settings panel: the FS isolation row is live (toggle
 * + persist); worktree and cap rows are display-only at this stage; opening
 * the panel closes other pickers (mutual exclusion).
 *
 * Mirrors the mountApp / typeText / pressEnter helper shape of
 * `tests/tui/fs-mode.test.tsx` (bun:test + testRender). Covers:
 *  1. bare `/config` opens the panel (three rows visible: title `设置`
 *     ("settings") + FS / worktree / cap row labels);
 *  2. Enter on the FS row flips the holder (fsMode.get() before/after
 *     differ) + onPersistFsMode is called;
 *  3. Esc closes the panel;
 *  4. mutual exclusion: opening `/config` while the memory picker is open →
 *     memory closes;
 *  5. FS row Enter failure (onPersistFsMode rejects) → notice appears,
 *     holder already flipped (runtime effect + persist-failure notice share
 *     the fire-and-forget failure fallback contract with the argumented
 *     runConfigSlashCommand path);
 *  6. Enter on the cap row is a no-op; Enter on the worktree row is a no-op;
 *  7. reopening the panel seeds from the current holder (flip, Esc, reopen →
 *     FS row shows the flipped value).
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
import type { PermissionModeContext } from "../../src/harness/permission/index.js";
import {
  createFsModeContext,
  type FsIsolationMode,
  type FsModeContext,
} from "../../src/harness/sandbox/fs-mode.js";
import {
  CONFIG_PICKER_WIDTH,
  configPickerRows,
  configRowKindFor,
  formatSubagentCapDisplay,
  formatWorktreeOnMutateDisplay,
  nextSubagentCap,
  reduceConfigPickerKey,
  toggleFsMode,
  toggleWorktreeOnMutate,
} from "../../src/tui/config-panel.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";
import { makeDeps } from "../cli/_fixtures.ts";

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

async function mountApp(opts: {
  readonly permissionMode: PermissionModeContext;
  readonly fsMode?: FsModeContext;
  readonly onPersistFsMode?: (mode: FsIsolationMode) => Promise<void>;
  readonly isolationOn?: boolean;
  // ADR-0096 — cap row optional wiring (holder + persist callback).
  readonly subagentCapHolder?: ReturnType<
    typeof import("../../src/harness/subagent/manager.js").createSubagentCapacityHolder
  >;
  readonly onPersistSubagentCap?: (patch: {
    readonly maxConcurrentWorkers: number | "unlimited";
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly subagentCapDisplay?: number | "unlimited";
  // ADR-0096 — worktree row optional wiring (holder + persist callback).
  readonly worktreeOnMutateHolder?: {
    get: () => boolean;
    set: (v: boolean) => void;
  };
  readonly onPersistWorktreeOnMutate?: (on: boolean) => Promise<void>;
}): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-cfg-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
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
      permissionMode={opts.permissionMode}
      fsMode={opts.fsMode}
      onPersistFsMode={opts.onPersistFsMode}
      isolationOn={opts.isolationOn}
      sessionGrants={createSessionGrants()}
      {...(opts.subagentCapDisplay !== undefined
        ? { subagentCapDisplay: opts.subagentCapDisplay }
        : {})}
      {...(opts.subagentCapHolder !== undefined
        ? { subagentCapHolder: opts.subagentCapHolder }
        : {})}
      {...(opts.onPersistSubagentCap !== undefined
        ? { onPersistSubagentCap: opts.onPersistSubagentCap }
        : {})}
      {...(opts.worktreeOnMutateHolder !== undefined
        ? { worktreeOnMutateHolder: opts.worktreeOnMutateHolder }
        : {})}
      {...(opts.onPersistWorktreeOnMutate !== undefined
        ? { onPersistWorktreeOnMutate: opts.onPersistWorktreeOnMutate }
        : {})}
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
    typeText: async (text) => {
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
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 150));
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await new Promise((r) => setTimeout(r, 80));
      await setup.renderOnce();
    },
  };
}

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

// ── pure units (reducer / formatter / rows) ────────────────────────────────

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

describe("reduceConfigPickerKey", () => {
  test("↓ clamp [0,2]", () => {
    expect(
      reduceConfigPickerKey(key({ downArrow: true }), { focusedIndex: 0 })
    ).toEqual({ kind: "move", index: 1 });
    expect(
      reduceConfigPickerKey(key({ downArrow: true }), { focusedIndex: 1 })
    ).toEqual({ kind: "move", index: 2 });
    expect(
      reduceConfigPickerKey(key({ downArrow: true }), { focusedIndex: 2 })
    ).toEqual({ kind: "move", index: 2 });
  });

  test("↑ clamp [0,2]", () => {
    expect(
      reduceConfigPickerKey(key({ upArrow: true }), { focusedIndex: 0 })
    ).toEqual({ kind: "move", index: 0 });
    expect(
      reduceConfigPickerKey(key({ upArrow: true }), { focusedIndex: 2 })
    ).toEqual({ kind: "move", index: 1 });
    expect(
      reduceConfigPickerKey(key({ upArrow: true }), { focusedIndex: 1 })
    ).toEqual({ kind: "move", index: 0 });
  });

  test("Enter → fix；Esc → commit", () => {
    expect(
      reduceConfigPickerKey(key({ return: true }), { focusedIndex: 0 })
    ).toEqual({ kind: "fix" });
    expect(
      reduceConfigPickerKey(key({ escape: true }), { focusedIndex: 2 })
    ).toEqual({ kind: "commit" });
  });

  test("ctrl/meta → ignore", () => {
    expect(
      reduceConfigPickerKey(
        { input: "c", key: { ...noKey, ctrl: true } },
        { focusedIndex: 0 }
      )
    ).toEqual({ kind: "ignore" });
  });

  test("Space / Tab / 其它 → ignore", () => {
    expect(
      reduceConfigPickerKey(key({ space: true }), { focusedIndex: 0 })
    ).toEqual({ kind: "ignore" });
    expect(
      reduceConfigPickerKey(key({ tab: true }), { focusedIndex: 1 })
    ).toEqual({ kind: "ignore" });
  });
});

describe("toggleFsMode", () => {
  test("global ↔ workspace 双向翻转", () => {
    expect(toggleFsMode("global")).toBe("workspace");
    expect(toggleFsMode("workspace")).toBe("global");
  });
});

// ADR-0096 ── cap row Enter cycle (pure: nextSubagentCap)
describe("nextSubagentCap", () => {
  test("闭集循环 3 → 5 → 9 → 15 → unlimited → 3", () => {
    expect(nextSubagentCap(3)).toBe(5);
    expect(nextSubagentCap(5)).toBe(9);
    expect(nextSubagentCap(9)).toBe(15);
    expect(nextSubagentCap(15)).toBe("unlimited");
    expect(nextSubagentCap("unlimited")).toBe(3);
  });
  test("undefined / 非法值 → 闭集首个（3）", () => {
    expect(nextSubagentCap(undefined)).toBe(3);
    expect(nextSubagentCap(7 as unknown as number)).toBe(3);
    expect(nextSubagentCap(null as unknown as number)).toBe(3);
  });
  test("循环一圈回到起点（idempotent at boundary）", () => {
    let cap = 3 as number | "unlimited";
    for (let i = 0; i < 5; i++) cap = nextSubagentCap(cap);
    expect(cap).toBe(3);
  });
});

describe("configRowKindFor", () => {
  test("focusedIndex → row kind 判别", () => {
    expect(configRowKindFor(0)).toBe("fsMode");
    expect(configRowKindFor(1)).toBe("worktreeOnMutate");
    expect(configRowKindFor(2)).toBe("subagentCap");
  });
});

describe("formatSubagentCapDisplay / formatWorktreeOnMutateDisplay", () => {
  test("cap 显示：number / unlimited / undefined", () => {
    expect(formatSubagentCapDisplay(15)).toBe("15");
    expect(formatSubagentCapDisplay("unlimited")).toBe("unlimited");
    expect(formatSubagentCapDisplay(undefined)).toBe("—");
  });

  test("worktree 显示：true / false / undefined", () => {
    expect(formatWorktreeOnMutateDisplay(true)).toBe("ON");
    expect(formatWorktreeOnMutateDisplay(false)).toBe("OFF");
    expect(formatWorktreeOnMutateDisplay(undefined)).toBe("OFF");
  });
});

describe("configPickerRows", () => {
  test("7 行 = 边框 2 + 标题 1 + 内容 3 + 键位提示 1", () => {
    expect(configPickerRows()).toBe(7);
  });
});

describe("CONFIG_PICKER_WIDTH 行预算（code-review High2 回归）", () => {
  // CJK = 2 columns wide (same metric as OpenTUI); ▸/·/space are ASCII.
  // Dependency-free implementation (string-width is ESM-only, so bun:test
  // inlines a same-metric counter; this comment pins the semantics).
  function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) {
      w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    }
    return w;
  }
  const prefix = "▸ ";
  const rows: ReadonlyArray<readonly [string, string]> = [
    // [label, value+hints full cross-product] — complete coverage of the
    // closed value domain (FS 2 tiers, worktree 2 tiers, cap 5 tiers × each
    // one's longest hint form). Any combination exceeding the inner width →
    // wrap → overflows configPickerRows()' row budget and squeezes the
    // transcript.
    ["文件系统隔离档", "global  ·  Enter 切换为 workspace"],
    ["文件系统隔离档", "workspace  ·  Enter 切换为 global"],
    ["worktree 门禁", "ON  ·  Enter 切换为 OFF"],
    ["worktree 门禁", "OFF  ·  Enter 切换为 ON"],
    ["子代理并发上限", "unlimited  ·  Enter 切换为 3"],
    ["子代理并发上限", "15  ·  Enter 切换为 unlimited"],
    ["子代理并发上限", "3  ·  Enter 切换为 5"],
  ];
  test("CONFIG_PICKER_WIDTH − 边框 2 − paddingX 2 ≥ 最宽行（所有值域组合）", () => {
    // CONFIG_PICKER_WIDTH − border 2 − paddingX 1 on each side = inner width
    const inner = CONFIG_PICKER_WIDTH - 4;
    let max = 0;
    for (const [label, rest] of rows) {
      const w = displayWidth(prefix + label + "  " + rest);
      if (w > max) max = w;
      expect(w).toBeLessThanOrEqual(inner);
    }
    // Widest row = 51 (FS row workspace→global form); inner width 52 ≥ 51
    // without large waste (a 50-wide PICKER_WIDTH leaves inner 46 < 51 —
    // exactly the defect that was fixed).
    expect(max).toBe(51);
    expect(inner).toBe(52);
  });
  test("read-only 行（仅显示后缀）也在预算内", () => {
    const inner = CONFIG_PICKER_WIDTH - 4;
    for (const [label, value] of [
      ["worktree 门禁", "OFF"],
      ["子代理并发上限", "—"],
    ] as const) {
      expect(
        displayWidth(`${prefix}${label}  ${value}  ·  (仅显示)`)
      ).toBeLessThanOrEqual(inner);
    }
  });
});

// ── app integration (mountApp + screen-frame assertions) ───────────────────

describe("TUI /config 面板集成（ADR-0096 T1）", () => {
  test("无参 /config 打开面板：三行可见（FS / worktree / cap）+ 标题「设置」", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({
      permissionMode,
      fsMode,
      isolationOn: true,
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("设置") && f.includes("文件系统隔离档"),
        8000,
        "open config"
      );
      expect(frame).toContain("设置");
      expect(frame).toContain("文件系统隔离档");
      expect(frame).toContain("global");
      expect(frame).toContain("worktree 门禁");
      expect(frame).toContain("ON"); // isolationOn=true → the worktree row shows ON
      expect(frame).toContain("子代理并发上限");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("FS 行 Enter 翻转 holder + onPersistFsMode 被调", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const calls: FsIsolationMode[] = [];
    const onPersistFsMode = async (m: FsIsolationMode) => {
      calls.push(m);
    };
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode,
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      // FS row focus at index=0 (default seed); Enter flips the holder
      await app.pressEnter();
      // The on-screen value changed (screen-frame assertion)
      await untilFrame(
        app.setup,
        (f) => f.includes("workspace"),
        4000,
        "value flipped"
      );
      expect(fsMode.get()).toBe("workspace");
      expect(calls).toEqual(["workspace"]);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("Esc 关闭面板（标题「设置」不再出现）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({ permissionMode, fsMode });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressEscape();
      // Title gone after Esc — wait 5 frames for the React commit to land
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 80));
        await app.setup.renderOnce();
        const f = app.setup.captureCharFrame();
        if (!f.includes("设置")) return;
      }
      throw new Error("面板未关闭");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("互斥：memory picker 开着时 /config 打开 → memory 关闭", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({ permissionMode, fsMode });
    try {
      // Open the memory picker first
      await app.typeText("/memory");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes("记忆开关"),
        8000,
        "memory open"
      );
      // Memory picker open → input disabled; drive panel keys directly: Esc
      // closes memory (memory picker's Esc = save-and-exit, equivalent to
      // closing the panel), then typeText refills /config (input active
      // again).
      app.setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 200));
      await app.setup.renderOnce();
      await new Promise((r) => setTimeout(r, 200));
      await app.setup.renderOnce();
      // Open /config again — config should open (memory already closed)
      await app.typeText("/config");
      await app.pressEnter();
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("设置"),
        8000,
        "config open"
      );
      expect(frame).toContain("设置");
      // Memory picker title gone (mutual-exclusion close worked)
      expect(frame).not.toContain("记忆开关");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("FS 行 Enter 失败（onPersistFsMode reject）→ holder 已翻、屏上落失败语义", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async () => {
        throw new Error("boom from persist cfg");
      },
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressEnter();
      // Holder already flipped (effective at runtime; UI fallback semantics)
      expect(fsMode.get()).toBe("workspace");
      // Fail notice on screen (notice section)
      await untilFrame(
        app.setup,
        (f) => f.includes("失败") || f.includes("boom"),
        6000,
        "failure notice"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("↑↓ 移焦点、holder 缺席时 Enter 在非 FS 行 no-op（cap / worktree 行不可改）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const calls: FsIsolationMode[] = [];
    const app = await mountApp({
      permissionMode,
      fsMode,
      onPersistFsMode: async (m) => {
        calls.push(m);
      },
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      // ↓ to the worktree row (index=1) — no holder, Enter is a no-op
      await app.pressArrow("down");
      await app.pressEnter();
      // ↑ back to the FS row (index=0)
      await app.pressArrow("up");
      // Then ↓ ↓ to the cap row (index=2) — no holder, Enter is a no-op
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // FS holder not flipped; persist not called
      expect(fsMode.get()).toBe("global");
      expect(calls).toEqual([]);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("重开面板 seed 自当前 holder（翻 holder 后 Esc、再开）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({ permissionMode, fsMode });
    try {
      // First open + flip
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open1");
      await app.pressEnter();
      expect(fsMode.get()).toBe("workspace");
      await app.pressEscape();
      // Close and reopen — the FS row should show the new value
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes("workspace"),
        8000,
        "reopen seed"
      );
      const frame = app.setup.captureCharFrame();
      expect(frame).toContain("workspace");
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap 行 + worktree 行在 props 缺席时显示占位（— / OFF）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("workspace");
    // Neither isolationOn nor subagentCapDisplay passed → placeholder
    const app = await mountApp({ permissionMode, fsMode });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      const frame = app.setup.captureCharFrame();
      expect(frame).toContain("workspace");
      expect(frame).toMatch(/OFF/); // worktree defaults to false → OFF
      expect(frame).toContain("—"); // cap undefined → —
    } finally {
      app.destroy();
    }
  }, 30_000);
});

// ── ADR-0096 ── cap row live: Enter cycle + persist + immediate holder reflection

describe("TUI /config 面板 cap 行激活（ADR-0096 T2）", () => {
  test("cap 行 Enter 循环 holder（3 → 5） + onPersistSubagentCap 被调", async () => {
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createSubagentCapacityHolder(3);
    const calls: Array<{ maxConcurrentWorkers: number | "unlimited" }> = [];
    const onPersistSubagentCap = async (patch: {
      readonly maxConcurrentWorkers: number | "unlimited";
    }) => {
      calls.push(patch);
      return { ok: true as const };
    };
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapHolder: holder,
      onPersistSubagentCap,
      subagentCapDisplay: 3,
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      // ↓ to the cap row (index=2), Enter flips 3 → 5
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      expect(holder.get()).toBe(5);
      expect(calls).toEqual([{ maxConcurrentWorkers: 5 }]);
      // The screen reflects the new value (capValue = "5")
      await untilFrame(
        app.setup,
        (f) => /子代理并发上限\s+5/.test(f),
        4000,
        "value flipped"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap 行 Enter 跨 unlimited 边界（15 → unlimited → 3）", async () => {
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createSubagentCapacityHolder(15);
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapHolder: holder,
      subagentCapDisplay: 15,
      onPersistSubagentCap: async () => ({ ok: true as const }),
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressArrow("down");
      // 1st: 15 → unlimited
      await app.pressEnter();
      expect(holder.get()).toBe("unlimited");
      // 2nd: unlimited → 3
      await app.pressEnter();
      expect(holder.get()).toBe(3);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("Enter 翻 holder 后单帧内屏上即变（回归：holder 非订阅源，须显式触发重渲染）", async () => {
    // Observed defect (real TUI): the holder is a plain object and `get()`
    // does not subscribe — flipping only the holder triggers no re-render,
    // so the screen value lags until the next focus move. Assert that after
    // Enter, with **no other key pressed**, the screen already shows the new
    // value (fixed 3-frame timing, not a long untilFrame poll).
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const capHolder = createSubagentCapacityHolder(3);
    const wtHolder = createWorktreeOnMutateHolder(false);
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapHolder: capHolder,
      subagentCapDisplay: 3,
      worktreeOnMutateHolder: wtHolder,
      onPersistSubagentCap: async () => ({ ok: true as const }),
      onPersistWorktreeOnMutate: async () => {},
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      // Focus → cap row, advance only 3 frames after Enter
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // Single-frame render (no polling, no extra keys): before the fix this
      // still showed the old value
      await app.setup.renderOnce();
      expect(capHolder.get()).toBe(5);
      expect(app.setup.captureCharFrame()).toMatch(/子代理并发上限\s+5/);
      // Same for the worktree row: ↑ to index=1, single frame after Enter
      await app.pressArrow("up");
      await app.pressEnter();
      await app.setup.renderOnce();
      expect(wtHolder.get()).toBe(true);
      expect(app.setup.captureCharFrame()).toMatch(/worktree 门禁\s+ON/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap 行 Enter 失败（onPersistSubagentCap reject）→ holder 已翻、屏上落失败语义", async () => {
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createSubagentCapacityHolder(5);
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapHolder: holder,
      subagentCapDisplay: 5,
      onPersistSubagentCap: async () => {
        throw new Error("boom from persist cap");
      },
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // Holder already flipped (effective at runtime; UI fallback semantics)
      expect(holder.get()).toBe(9);
      // Fail notice on screen (notice section)
      await untilFrame(
        app.setup,
        (f) => f.includes("失败") || f.includes("boom"),
        6000,
        "failure notice"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap holder 缺席 → cap 行 Enter no-op（保留 T1 行为）", async () => {
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapDisplay: 15,
      // Deliberately not passing subagentCapHolder — the cap row degrades to
      // read-only
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // The screen still shows 15 (unchanged)
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/子代理并发上限\s+15/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap persist 返回 {ok:false}（不 reject）→ 屏上落失败语义（回归：结构化失败曾静默吞掉）", async () => {
    // persistSubagentCapImpl **returns** `{ok:false, reason}` after catching
    // an error instead of throwing — before the fix app.tsx only attached
    // .catch, so the resolved failure result was discarded by `void` and no
    // failure notice appeared. Assert the {ok:false} path also lands a
    // notice (both failure channels are semantically equal).
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createSubagentCapacityHolder(5);
    const app = await mountApp({
      permissionMode,
      fsMode,
      subagentCapHolder: holder,
      subagentCapDisplay: 5,
      onPersistSubagentCap: async () => ({
        ok: false as const,
        reason: "EACCES: settings.json is read-only",
      }),
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // Holder already flipped (effective at runtime; persist failure does
      // not roll back)
      expect(holder.get()).toBe(9);
      // The {ok:false} reason also lands on screen (notice on the non-reject
      // path)
      await untilFrame(
        app.setup,
        (f) => f.includes("保存失败") && f.includes("EACCES"),
        6000,
        "structured failure notice"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);
});

// ── ADR-0096 ── worktree gate row live: Enter flip + persist + immediate holder reflection ──

describe("TUI /config 面板 worktree 行激活（ADR-0096 T3）", () => {
  test("worktree 行 Enter 翻 holder（OFF → ON）+ onPersistWorktreeOnMutate 被调", async () => {
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createWorktreeOnMutateHolder(false);
    const calls: boolean[] = [];
    const app = await mountApp({
      permissionMode,
      fsMode,
      worktreeOnMutateHolder: holder,
      onPersistWorktreeOnMutate: async (on) => {
        calls.push(on);
      },
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      // ↓ to the worktree row (index=1), Enter flips OFF → ON
      await app.pressArrow("down");
      await app.pressEnter();
      expect(holder.get()).toBe(true);
      expect(calls).toEqual([true]);
      // The screen reflects the new value
      await untilFrame(
        app.setup,
        (f) => /worktree 门禁\s+ON/.test(f),
        4000,
        "value flipped to ON"
      );
      // Enter again flips back to OFF (ON → OFF is symmetric)
      await app.pressEnter();
      expect(holder.get()).toBe(false);
      expect(calls).toEqual([true, false]);
      await untilFrame(
        app.setup,
        (f) => /worktree 门禁\s+OFF/.test(f),
        4000,
        "value flipped to OFF"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("重开面板 seed 自 holder（翻 ON 后 Esc、再开显示 ON）", async () => {
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createWorktreeOnMutateHolder(false);
    const app = await mountApp({
      permissionMode,
      fsMode,
      worktreeOnMutateHolder: holder,
      onPersistWorktreeOnMutate: async () => {},
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open1");
      await app.pressArrow("down");
      await app.pressEnter();
      expect(holder.get()).toBe(true);
      await app.pressEscape();
      // Close and reopen — the worktree row should show ON (holder-driven,
      // not a boot snapshot)
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => /worktree 门禁\s+ON/.test(f),
        8000,
        "reopen seed from holder"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("worktree 行 Enter 失败（persist reject）→ holder 已翻、屏上落失败语义", async () => {
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const holder = createWorktreeOnMutateHolder(false);
    const app = await mountApp({
      permissionMode,
      fsMode,
      worktreeOnMutateHolder: holder,
      onPersistWorktreeOnMutate: async () => {
        throw new Error("boom from persist worktree");
      },
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressEnter();
      // Holder already flipped (the gate's next wave adjudicates by the new
      // value; failure is not withdrawn — same as FS / cap)
      expect(holder.get()).toBe(true);
      await untilFrame(
        app.setup,
        (f) => f.includes("失败") || f.includes("boom"),
        6000,
        "failure notice"
      );
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("holder 在场时 worktree 行显示 Enter 提示（不再是「仅显示」）；holder 缺席时相反", async () => {
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const withHolder = await mountApp({
      permissionMode,
      fsMode,
      worktreeOnMutateHolder: createWorktreeOnMutateHolder(true),
      onPersistWorktreeOnMutate: async () => {},
    });
    try {
      await withHolder.typeText("/config");
      await withHolder.pressEnter();
      const frame = await untilFrame(
        withHolder.setup,
        (f) => f.includes("设置"),
        8000,
        "open with holder"
      );
      expect(frame).toContain("Enter 切换为 OFF");
    } finally {
      withHolder.destroy();
    }

    const withSnapshot = await mountApp({
      permissionMode: createPermissionModeContext("default"),
      fsMode: createFsModeContext("global"),
      isolationOn: true,
      // No holder passed → display-only form
    });
    try {
      await withSnapshot.typeText("/config");
      await withSnapshot.pressEnter();
      const frame = await untilFrame(
        withSnapshot.setup,
        (f) => f.includes("设置"),
        8000,
        "open snapshot"
      );
      // The static snapshot still drives the display value (ON), but the row
      // is read-only
      expect(frame).toMatch(/worktree 门禁\s+ON/);
      expect(frame).toContain("仅显示");
    } finally {
      withSnapshot.destroy();
    }
  }, 30_000);

  test("worktree holder 翻转不影响 FS / cap 行（三行独立）", async () => {
    const { createWorktreeOnMutateHolder } =
      await import("../../src/harness/isolation/worktree-gate.js");
    const { createSubagentCapacityHolder } =
      await import("../../src/harness/subagent/manager.js");
    const permissionMode = createPermissionModeContext("default");
    const fsMode = createFsModeContext("global");
    const capHolder = createSubagentCapacityHolder(9);
    const app = await mountApp({
      permissionMode,
      fsMode,
      worktreeOnMutateHolder: createWorktreeOnMutateHolder(false),
      onPersistWorktreeOnMutate: async () => {},
      subagentCapHolder: capHolder,
      subagentCapDisplay: 9,
      onPersistSubagentCap: async () => ({ ok: true as const }),
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressEnter();
      // worktree flipped; FS / cap untouched
      expect(fsMode.get()).toBe("global");
      expect(capHolder.get()).toBe(9);
      expect(app.setup.captureCharFrame()).toMatch(/文件系统隔离档\s+global/);
      expect(app.setup.captureCharFrame()).toMatch(/子代理并发上限\s+9/);
    } finally {
      app.destroy();
    }
  }, 30_000);
});

describe("toggleWorktreeOnMutate（pure）", () => {
  test("false → true，true → false（与 formatWorktreeOnMutateDisplay 同闭集）", () => {
    expect(toggleWorktreeOnMutate(false)).toBe(true);
    expect(toggleWorktreeOnMutate(true)).toBe(false);
    expect(formatWorktreeOnMutateDisplay(toggleWorktreeOnMutate(false))).toBe(
      "ON"
    );
    expect(formatWorktreeOnMutateDisplay(toggleWorktreeOnMutate(true))).toBe(
      "OFF"
    );
  });
});

// Component mounting goes through TuiApp integration (same discipline as
// model-picker / memory-picker — `useTimeline`'s continuous animation keeps
// waitForVisualIdle from ever reaching idle, so standalone mounting has no
// landing point; the JSX runtime is covered by the 8 TuiApp integration
// cases).
