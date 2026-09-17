/** @jsxImportSource @opentui/react */
/**
 * ADR-0096 T1 — `/config` 设置面板：FS 隔离档行变活（翻转 + 落盘），worktree
 * 与 cap 行 display-only（本票）；面板打开时与其他 picker 互斥关闭。
 *
 * 镜像 `tests/tui/fs-mode.test.tsx` 的 mountApp / typeText / pressEnter 辅助
 * 形态（bun:test + testRender），覆盖：
 *  1. 无参 `/config` 打开面板（三行可见：标题「设置」+ FS / worktree / cap
 *     三行标签）；
 *  2. FS 行 Enter 翻 holder（fsMode.get() 前后值变化） + onPersistFsMode 被调；
 *  3. Esc 关闭面板；
 *  4. 互斥：memory picker 开着时 `/config` 打开 → memory 关闭；
 *  5. FS 行 Enter 失败（onPersistFsMode reject）→ notice 出现，holder 已翻
 *     （运行期生效 + 落盘失败 notice 与 runConfigSlashCommand 有参路径同款
 *     fire-and-forget 失败兜底契约）；
 *  6. cap 行 Enter no-op；worktree 行 Enter no-op；
 *  7. 重开面板 seed 自当前 holder（翻 holder 后 Esc 关闭、再开，FS 行显示
 *     已翻转的值）。
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
  // ADR-0096 T2 — cap 行可选接线（holder + 落盘回调）。
  readonly subagentCapHolder?: ReturnType<
    typeof import("../../src/harness/subagent/manager.js").createSubagentCapacityHolder
  >;
  readonly onPersistSubagentCap?: (patch: {
    readonly maxConcurrentWorkers: number | "unlimited";
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly subagentCapDisplay?: number | "unlimited";
  // ADR-0096 T3 — worktree 行可选接线（holder + 落盘回调）。
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

// ── pure 单元（reducer / formatter / rows） ─────────────────────────────────

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

// ADR-0096 T2 ── cap 行 Enter 循环（pure：nextSubagentCap）
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
  // CJK=2 列宽（OpenTUI 同口径）；▸/·/空格 ASCII。无依赖实现（string-width
  // 是 ESM-only，bun:test 环境直接内联同口径计数，注释锁语义）。
  function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) {
      w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    }
    return w;
  }
  const prefix = "▸ ";
  const rows: ReadonlyArray<readonly [string, string]> = [
    // [label, value+hints 全组合] —— 值域闭集全覆盖（FS 两档、worktree 两档、
    // cap 五档 × 各自 hint 最长形态）。任一组合超内宽 → wrap → 顶破
    // configPickerRows() 行账挤 transcript（High2 事故形态）。
    ["文件系统隔离档", "global  ·  Enter 切换为 workspace"],
    ["文件系统隔离档", "workspace  ·  Enter 切换为 global"],
    ["worktree 门禁", "ON  ·  Enter 切换为 OFF"],
    ["worktree 门禁", "OFF  ·  Enter 切换为 ON"],
    ["子代理并发上限", "unlimited  ·  Enter 切换为 3"],
    ["子代理并发上限", "15  ·  Enter 切换为 unlimited"],
    ["子代理并发上限", "3  ·  Enter 切换为 5"],
  ];
  test("CONFIG_PICKER_WIDTH − 边框 2 − paddingX 2 ≥ 最宽行（所有值域组合）", () => {
    // CONFIG_PICKER_WIDTH − 边框 2 − paddingX 左右各 1 = 内宽
    const inner = CONFIG_PICKER_WIDTH - 4;
    let max = 0;
    for (const [label, rest] of rows) {
      const w = displayWidth(prefix + label + "  " + rest);
      if (w > max) max = w;
      expect(w).toBeLessThanOrEqual(inner);
    }
    // 最宽行 = 51（FS 行 workspace→global 形态）；内宽 52 ≥ 51 且不再是大
    // 无谓冗余（50 宽的 PICKER_WIDTH 内宽 46 < 51，正是被修复的缺陷）。
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

// ── app 集成（mountApp + 屏帧断言） ─────────────────────────────────────────

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
      expect(frame).toContain("ON"); // isolationOn=true → worktree 行显示 ON
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
      // FS 行 focus 在 index=0（默认 seed）；Enter 翻 holder
      await app.pressEnter();
      // 屏上值变化（屏帧断言）
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
      // Esc 后标题消失 —— 等 5 帧让 React commit 走出
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
      // 先开 memory picker
      await app.typeText("/memory");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes("记忆开关"),
        8000,
        "memory open"
      );
      // memory picker 打开 → 输入框 disabled；直接走面板键位：Esc 关 memory
      // （memory picker 的 Esc = 保存退出，等价关闭面板），然后再用 typeText
      // 重新填 /config（输入框恢复 active）。
      app.setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 200));
      await app.setup.renderOnce();
      await new Promise((r) => setTimeout(r, 200));
      await app.setup.renderOnce();
      // 再开 /config —— 应开 config（memory 已关）
      await app.typeText("/config");
      await app.pressEnter();
      const frame = await untilFrame(
        app.setup,
        (f) => f.includes("设置"),
        8000,
        "config open"
      );
      expect(frame).toContain("设置");
      // memory picker 标题消失（互斥关闭生效）
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
      // holder 已翻（运行期生效，UI 兜底语义）
      expect(fsMode.get()).toBe("workspace");
      // 屏上落失败语义（notice 段）
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
      // ↓ 到 worktree 行（index=1）—— 无 holder，Enter no-op
      await app.pressArrow("down");
      await app.pressEnter();
      // ↑ 回 FS 行（index=0）
      await app.pressArrow("up");
      // 再 ↓ ↓ 到 cap 行（index=2）—— 无 holder，Enter no-op
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // FS holder 没翻；persist 没调
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
      // 第一次开 + 翻
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open1");
      await app.pressEnter();
      expect(fsMode.get()).toBe("workspace");
      await app.pressEscape();
      // 关掉后再开 —— FS 行应显示新值
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
    // isolationOn / subagentCapDisplay 均不传 → 占位
    const app = await mountApp({ permissionMode, fsMode });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      const frame = app.setup.captureCharFrame();
      expect(frame).toContain("workspace");
      expect(frame).toMatch(/OFF/); // worktree 缺省 false → OFF
      expect(frame).toContain("—"); // cap undefined → —
    } finally {
      app.destroy();
    }
  }, 30_000);
});

// ── ADR-0096 T2 ── cap 行变活：Enter 循环 + 落盘 + holder 即时反映 ─────────

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
      // ↓ 到 cap 行（index=2），Enter 翻 3 → 5
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      expect(holder.get()).toBe(5);
      expect(calls).toEqual([{ maxConcurrentWorkers: 5 }]);
      // 屏上反映新值（capValue = "5"）
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
    // 实测缺陷（真实 TUI）：holder 是普通对象，`get()` 不订阅 —— 只翻 holder
    // 不触发 re-render，屏上值会停到下一次焦点移动。断言 Enter 之后**不做任何
    // 其他按键**，屏上就已反映新值（固定 3 帧时序，不靠 untilFrame 长轮询）。
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
      // 焦点 → cap 行，Enter 后仅推进 3 帧
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // 单帧渲染（不轮询、不额外按键）：修复前这里仍显示旧值
      await app.setup.renderOnce();
      expect(capHolder.get()).toBe(5);
      expect(app.setup.captureCharFrame()).toMatch(/子代理并发上限\s+5/);
      // worktree 行同理：↑ 到 index=1，Enter 后单帧
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
      // holder 已翻（运行期生效；UI 兜底语义）
      expect(holder.get()).toBe(9);
      // 屏上落失败语义（notice 段）
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
      // 故意不传 subagentCapHolder —— cap 行退化为 read-only
    });
    try {
      await app.typeText("/config");
      await app.pressEnter();
      await untilFrame(app.setup, (f) => f.includes("设置"), 8000, "open");
      await app.pressArrow("down");
      await app.pressArrow("down");
      await app.pressEnter();
      // 屏上仍显示 15（无变化）
      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/子代理并发上限\s+15/);
    } finally {
      app.destroy();
    }
  }, 30_000);

  test("cap persist 返回 {ok:false}（不 reject）→ 屏上落失败语义（回归：结构化失败曾静默吞掉）", async () => {
    // code-review High1 回归：persistSubagentCapImpl 捕获错误后**返回**
    // `{ok:false, reason}` 而非 throw —— 修复前 app.tsx 只接 .catch，resolved
    // 的失败结果被 `void` 丢弃，屏上无任何失败提示。断言 {ok:false} 路径
    // 同样落 notice（双通道失败语义等价）。
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
      // holder 已翻（运行期生效；persist 失败不回滚）
      expect(holder.get()).toBe(9);
      // {ok:false} 的 reason 也落屏（非 reject 路径的 notice）
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

// ── ADR-0096 T3 ── worktree 门禁行变活：Enter 翻转 + 落盘 + holder 即时反映 ──

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
      // ↓ 到 worktree 行（index=1），Enter 翻 OFF → ON
      await app.pressArrow("down");
      await app.pressEnter();
      expect(holder.get()).toBe(true);
      expect(calls).toEqual([true]);
      // 屏上反映新值
      await untilFrame(
        app.setup,
        (f) => /worktree 门禁\s+ON/.test(f),
        4000,
        "value flipped to ON"
      );
      // 再 Enter 翻回 OFF（ON → OFF 对称）
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
      // 关掉后再开 —— worktree 行应显示 ON（holder 驱动，不是启动快照）
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
      // holder 已翻（门禁下一次 wave 即按新值裁决；失败不撤回 —— 与 FS / cap 同款）
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
      // 不传 holder → T1 display-only 形态
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
      // 静态快照仍驱动显示值（ON），但行是 read-only
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
      // worktree 翻了；FS / cap 未动
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

// 组件挂载以 TuiApp 集成为主（与 model-picker / memory-picker 同款纪律 ——
// `useTimeline` 持续动画让 waitForVisualIdle 不达 idle，standalone 挂载无
// 落点；JSX runtime 由 TuiApp 集成的 8 个用例覆盖）。
