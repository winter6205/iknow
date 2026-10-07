/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-picker.test.tsx
 *
 * Thinking picker (dual-panel) tests:
 *  - effortToIndex / indexToEffort SSOT mapping (5 concrete levels + ""
 *    round-trip idempotence, out-of-range fallback);
 *  - THINKING_LEVELS reuses slash.ts ADJUSTABLE_EFFORT_LEVELS (same
 *    reference, no duplicate definition);
 *  - reduceThinkingSwitchKey pure key-routing (switch panel: toggle / commit / ignore);
 *  - reduceThinkingEffortKey pure key-routing (effort panel: move clamp / fix / commit);
 *  - ThinkingPicker render smoke -- uses a real
 *    createCliRenderer (memory buffered) + getRealCharBytes to grab plain
 *    text, not testRender (the animated box renders blank on the first frame
 *    under testRender).
 *  - app-layer integration: /thinking opens the switch panel (Enter fixes
 *    without closing / Esc saves-and-exits writing state); /effort <level>
 *    opens the effort panel (move + Enter fixes without closing / Esc saves
 *    and exits writing state).
 *
 * Pure-function units need no OpenTUI mock; the render smoke needs a real
 * renderer (Linux bun).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "stream";
import { act } from "react";
import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createRoot } from "@opentui/react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  PICKER_WIDTH,
  THINKING_LEVELS,
  ThinkingPicker,
  committedThinkingPatch,
  effortToDisplayIndex,
  effortToIndex,
  indexToEffort,
  reduceThinkingEffortKey,
  reduceThinkingSwitchKey,
  type ThinkingPickerState,
} from "../../src/tui/thinking-picker.js";
import { ADJUSTABLE_EFFORT_LEVELS } from "../../src/tui/slash.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";
import { flushRendererFrame, setReactActEnvironment } from "./_fixtures.tsx";

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

// -- effortToIndex / indexToEffort (SSOT mapping) -------------------------------

describe("effortToIndex / indexToEffort（SSOT 映射）", () => {
  test("5 档 concrete + 空串 往返幂等", () => {
    for (const [effort, index] of [
      ["low", 0],
      ["medium", 1],
      ["high", 2],
      ["xhigh", 3],
      ["max", 4],
      ["", -1],
    ] as const) {
      expect(effortToIndex(effort)).toBe(index);
      expect(indexToEffort(index)).toBe(effort);
    }
  });

  test("effortToIndex 边界：low→0 / max→4 / 空串→-1", () => {
    expect(effortToIndex("low")).toBe(0);
    expect(effortToIndex("max")).toBe(4);
    expect(effortToIndex("")).toBe(-1);
  });

  test("indexToEffort 越界（-2 / 5 / 99）→ 空串", () => {
    expect(indexToEffort(-2)).toBe("");
    expect(indexToEffort(-1)).toBe("");
    expect(indexToEffort(5)).toBe("");
    expect(indexToEffort(99)).toBe("");
  });

  test("effortToDisplayIndex：空串 → 1（medium，spec §0 档位默认），concrete 原样", () => {
    expect(effortToDisplayIndex("")).toBe(1);
    expect(effortToDisplayIndex("low")).toBe(0);
    expect(effortToDisplayIndex("medium")).toBe(1);
    expect(effortToDisplayIndex("high")).toBe(2);
    expect(effortToDisplayIndex("xhigh")).toBe(3);
    expect(effortToDisplayIndex("max")).toBe(4);
  });

  test("effortToDisplayIndex 往返：commit 直接 Enter 时空串映射为 medium", () => {
    // /effort opens with default effort="" -> display focuses medium -> Enter fixes medium
    expect(indexToEffort(effortToDisplayIndex(""))).toBe("medium");
  });

  test("THINKING_LEVELS 复用 slash.ts ADJUSTABLE_EFFORT_LEVELS（同引用，顺序一致）", () => {
    expect(THINKING_LEVELS).toBe(ADJUSTABLE_EFFORT_LEVELS);
    expect(THINKING_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

// -- committedThinkingPatch (settings two-way persistence payload projection) -----------

describe("committedThinkingPatch（commit payload 投影）", () => {
  test("thinking 面板 enabled=true → { thinking: 'adaptive' } 且无 effort 键", () => {
    const patch = committedThinkingPatch({ kind: "thinking", enabled: true });
    expect(patch).not.toBeNull();
    expect(patch!.thinking).toBe("adaptive");
    expect("thinkingEffort" in patch!).toBe(false); // switch panel never touches the level (memory preserved)
  });

  test("thinking 面板 enabled=false → { thinking: 'off' }", () => {
    expect(
      committedThinkingPatch({ kind: "thinking", enabled: false })
    ).toEqual({
      thinking: "off",
    });
  });

  test("effort 面板 autoOn=true → { thinking: 'adaptive', thinkingEffort: null }", () => {
    expect(
      committedThinkingPatch({
        kind: "effort",
        focusedIndex: 2,
        currentIndex: 2,
        autoOn: true,
      })
    ).toEqual({ thinking: "adaptive", thinkingEffort: null });
  });

  test("effort 面板 concrete 档 → 按 currentIndex（已固定档）映射五档", () => {
    // All five levels: currentIndex is the committed level after Enter (Esc
    // saves and exits writing it); focusedIndex is only the in-motion preview
    // and never participates in the projection.
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (let i = 0; i < levels.length; i++) {
      expect(
        committedThinkingPatch({
          kind: "effort",
          focusedIndex: 2, // deliberately apart from committed: focus is not the committed level
          currentIndex: i,
          autoOn: false,
        })
      ).toEqual({ thinking: "adaptive", thinkingEffort: levels[i] });
    }
  });

  test("当前判别联合下 null 分支不可达（防御）", () => {
    // ThinkingPickerState has only kind:"thinking" | "effort" variants; the
    // default branch fires only if a future variant is added -- feed an unknown
    // kind via type assertion to verify the fallback semantics.
    const unreachable = {
      kind: "future-kind",
    } as unknown as ThinkingPickerState;
    expect(committedThinkingPatch(unreachable)).toBeNull();
  });
});

// -- reduceThinkingSwitchKey (switch panel: Space/Tab toggle · Enter fix · Esc commit) ---

describe("reduceThinkingSwitchKey（开关面板）", () => {
  test("Space → toggle（翻转面板内开关预览）", () => {
    expect(reduceThinkingSwitchKey(key({ space: true }))).toEqual({
      type: "toggle",
    });
  });

  test("Tab → toggle（与 Space 同效）", () => {
    expect(reduceThinkingSwitchKey(key({ tab: true }))).toEqual({
      type: "toggle",
    });
  });

  test("Enter → fix（固定当前预览，不翻转、面板保持打开）", () => {
    expect(reduceThinkingSwitchKey(key({ return: true }))).toEqual({
      type: "fix",
    });
  });

  test("Esc → commit（保存退出，无 cancel 路径）", () => {
    expect(reduceThinkingSwitchKey(key({ escape: true }))).toEqual({
      type: "commit",
    });
  });

  test("ctrl/meta 组合键 → ignore（让给既有路由，Ctrl+C/O 不被吞）", () => {
    expect(
      reduceThinkingSwitchKey({ input: "c", key: { ...noKey, ctrl: true } })
    ).toEqual({ type: "ignore" });
    expect(
      reduceThinkingSwitchKey({ input: "m", key: { ...noKey, meta: true } })
    ).toEqual({ type: "ignore" });
  });

  test("up / down → ignore（档位面板交互，开关面板不消费）", () => {
    expect(reduceThinkingSwitchKey(key({ upArrow: true }))).toEqual({
      type: "ignore",
    });
    expect(reduceThinkingSwitchKey(key({ downArrow: true }))).toEqual({
      type: "ignore",
    });
  });

  test("可打印字符 'a' → ignore（不设 hotkey 直选）", () => {
    expect(reduceThinkingSwitchKey({ input: "a", key: { ...noKey } })).toEqual({
      type: "ignore",
    });
  });
});

// -- reduceThinkingEffortKey (effort panel: ←/→ move clamp · Space/Tab toggleAuto ·
//    Enter fix · Esc commit) -

describe("reduceThinkingEffortKey（档位面板）", () => {
  test("focused=2 → → move index=3（xhigh）", () => {
    expect(
      reduceThinkingEffortKey(key({ rightArrow: true }), { focusedIndex: 2 })
    ).toEqual({ type: "move", index: 3 });
  });

  test("focused=4 → → move index=4（clamp 顶）", () => {
    expect(
      reduceThinkingEffortKey(key({ rightArrow: true }), { focusedIndex: 4 })
    ).toEqual({ type: "move", index: 4 });
  });

  test("focused=0 → ← move index=0（clamp 底）", () => {
    expect(
      reduceThinkingEffortKey(key({ leftArrow: true }), { focusedIndex: 0 })
    ).toEqual({ type: "move", index: 0 });
  });

  test("focused=1 → ← move index=0（low）", () => {
    expect(
      reduceThinkingEffortKey(key({ leftArrow: true }), { focusedIndex: 1 })
    ).toEqual({ type: "move", index: 0 });
  });

  test("Enter → fix（固定焦点为 committed，面板保持打开）", () => {
    expect(
      reduceThinkingEffortKey(key({ return: true }), { focusedIndex: 3 })
    ).toEqual({ type: "fix" });
  });

  test("Esc → commit（保存退出，无 cancel 路径）", () => {
    expect(
      reduceThinkingEffortKey(key({ escape: true }), { focusedIndex: 2 })
    ).toEqual({ type: "commit" });
  });

  test("ctrl/meta 组合键 → ignore（让给既有路由）", () => {
    expect(
      reduceThinkingEffortKey(
        { input: "c", key: { ...noKey, ctrl: true } },
        { focusedIndex: 2 }
      )
    ).toEqual({ type: "ignore" });
    expect(
      reduceThinkingEffortKey(
        { input: "m", key: { ...noKey, meta: true } },
        { focusedIndex: 2 }
      )
    ).toEqual({ type: "ignore" });
  });

  test("Space → toggleAuto（切换自适应 auto 态）", () => {
    expect(
      reduceThinkingEffortKey(key({ space: true }), { focusedIndex: 2 })
    ).toEqual({ type: "toggleAuto" });
  });

  test("Tab → toggleAuto（与 Space 同效）", () => {
    expect(
      reduceThinkingEffortKey(key({ tab: true }), { focusedIndex: 2 })
    ).toEqual({ type: "toggleAuto" });
  });

  test("up / down → ignore", () => {
    expect(
      reduceThinkingEffortKey(key({ upArrow: true }), { focusedIndex: 2 })
    ).toEqual({ type: "ignore" });
    expect(
      reduceThinkingEffortKey(key({ downArrow: true }), { focusedIndex: 2 })
    ).toEqual({ type: "ignore" });
  });

  test("可打印字符 'a' → ignore（不设 hotkey 直选）", () => {
    expect(
      reduceThinkingEffortKey(
        { input: "a", key: { ...noKey } },
        {
          focusedIndex: 2,
        }
      )
    ).toEqual({ type: "ignore" });
  });
});

// -- ThinkingPicker render smoke (real renderer, visual contract) ---------------

/** Test-only stdout (Writable + isTTY + columns/rows); never touches process.stdout. */
class TestWriteStream extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  _write(_chunk: unknown, _encoding: string, callback: () => void): void {
    callback();
  }
  getColorDepth(): number {
    return 24;
  }
}

/** Open a memory-buffered real renderer, mount ThinkingPicker, return one plain-text frame. */
async function renderPickerText(
  state: ThinkingPickerState,
  cols = 80
): Promise<string> {
  setReactActEnvironment(true);
  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  const stdout = new TestWriteStream(cols, 24) as unknown as NodeJS.WriteStream;
  const config: CliRendererConfig = {
    stdin,
    stdout,
    width: cols,
    height: 24,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitOnCtrlC: false,
  };
  const renderer = await createCliRenderer(config);
  const root = createRoot(renderer);
  try {
    act(() => {
      root.render(<ThinkingPicker state={state} />);
    });
    await flushRendererFrame(renderer);
    const bytes = renderer.currentRenderBuffer.getRealCharBytes(true);
    return new TextDecoder().decode(bytes);
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    // Restore the global even on assertion failure to avoid polluting later cases.
    setReactActEnvironment(false);
  }
}

/** True if any physical line contains both `[Esc]` and `保存退出` ("save and exit") --
 *  the hint may wrap on narrow terminals, so the combined hint is not guaranteed
 *  contiguous on one line; relaxed to a cross-line existence assertion. */
function frameHasSaveEscHint(frame: string): boolean {
  return frame
    .split("\n")
    .some((line) => line.includes("[Esc]") && line.includes("保存退出"));
}

describe("ThinkingPicker 渲染（design-25 视觉 smoke）", () => {
  test("开关面板 ON：标题「思考开关」+ ON + 思考已开启，无进度条", async () => {
    const frame = await renderPickerText({ kind: "thinking", enabled: true });
    expect(frame).toContain("思考开关");
    expect(frame).toContain("ON");
    expect(frame).toContain("思考已开启");
    expect(frame).toContain("◐"); // switch dot lit (ON)
    expect(frame).not.toContain("█"); // pure switch panel has no progress bar (user-requested)
    expect(frame).toContain("╭"); // rounded border top
    expect(frame).toContain("╰"); // rounded border bottom
  });

  test("开关面板 OFF：OFF + 思考已关闭，无进度条", async () => {
    const frame = await renderPickerText({ kind: "thinking", enabled: false });
    expect(frame).toContain("思考开关");
    expect(frame).toContain("OFF");
    expect(frame).toContain("思考已关闭");
    expect(frame).toContain("◑"); // switch dot dim (OFF)
    expect(frame).not.toContain("█"); // pure switch panel has no progress bar
  });

  test("档位面板：标题「思考强度」+ 5 档标签 + ▸ high ◂ 焦点游标", async () => {
    const frame = await renderPickerText({
      kind: "effort",
      focusedIndex: 2,
      currentIndex: 1,
      autoOn: false,
    });
    expect(frame).toContain("思考强度");
    expect(frame).toContain("手动档位");
    for (const label of ["low", "medium", "high", "xhigh", "max"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("▸ high ◂");
    expect(frame).toContain("█"); // effort panel keeps the progress bar
    expect(frame).toContain("╭"); // rounded border top
    expect(frame).toContain("╰"); // rounded border bottom
  });

  test("档位面板：焦点游标与已固定档分离（focus 与 committed 并存）", async () => {
    const frame = await renderPickerText({
      kind: "effort",
      focusedIndex: 3,
      currentIndex: 1,
      autoOn: false,
    });
    // Focus cursor on xhigh (in-motion preview); the committed level medium is also highlighted at the same time.
    expect(frame).toContain("▸ xhigh ◂");
    expect(frame).toContain("medium");
  });

  test("档位面板 auto 态：AUTO · 自适应 + 5 档灰显无光标、无手动档位", async () => {
    const frame = await renderPickerText({
      kind: "effort",
      focusedIndex: 1,
      currentIndex: 1,
      autoOn: true,
    });
    expect(frame).toContain("AUTO");
    expect(frame).toContain("自适应");
    expect(frame).not.toContain("手动档位");
    for (const label of ["low", "medium", "high", "xhigh", "max"]) {
      expect(frame).toContain(label); // 5 level labels still present (greyed out)
    }
    expect(frame).not.toContain("▸"); // no focus cursor in auto state
    expect(frame).toContain("█"); // progress bar still present (fully dim track)
  });

  test("面板固定宽：cols 变化不影响面板宽度，且靠左对齐（不占满屏宽）", async () => {
    // PICKER_WIDTH fixed + alignSelf flex-start -> panel width does not follow
    // terminal cols, and hugs the left edge (top row starts with the rounded
    // ╭). getRealCharBytes pads every frame row to terminal width, so assert
    // on the real panel width after trimEnd.
    const narrow = await renderPickerText(
      { kind: "effort", focusedIndex: 1, currentIndex: 1, autoOn: false },
      60
    );
    const wide = await renderPickerText(
      { kind: "effort", focusedIndex: 1, currentIndex: 1, autoOn: false },
      120
    );
    const topNarrow = narrow.split("\n").find((l) => l.includes("╭"));
    const topWide = wide.split("\n").find((l) => l.includes("╭"));
    expect(topNarrow).toBeDefined();
    expect(topWide).toBeDefined();
    expect(topNarrow!.trimEnd().length).toBe(topWide!.trimEnd().length);
    expect(topNarrow!.trimEnd().length).toBe(PICKER_WIDTH);
    // Left-aligned: top row starts with the rounded border origin ╭ (no leading whitespace fill).
    expect(topNarrow!.startsWith("╭")).toBe(true);
    // Does not span full width: real panel width < terminal cols.
    expect(topNarrow!.trimEnd().length).toBeLessThan(60);
  });

  test("键位提示行：两面板均含 [Esc 保存退出] 文案", async () => {
    const on = await renderPickerText({ kind: "thinking", enabled: true });
    expect(frameHasSaveEscHint(on)).toBe(true);
    const off = await renderPickerText({ kind: "thinking", enabled: false });
    expect(frameHasSaveEscHint(off)).toBe(true);
    const effort = await renderPickerText({
      kind: "effort",
      focusedIndex: 0,
      currentIndex: 0,
      autoOn: false,
    });
    expect(frameHasSaveEscHint(effort)).toBe(true);
    const effortAuto = await renderPickerText({
      kind: "effort",
      focusedIndex: 0,
      currentIndex: 0,
      autoOn: true,
    });
    expect(frameHasSaveEscHint(effortAuto)).toBe(true); // auto-state hint shares the same physical line
  });

  test("开关面板不含档位标签（低/中/高档名不可见，纯开关）", async () => {
    const frame = await renderPickerText({ kind: "thinking", enabled: true });
    // The switch panel is pure ON/OFF: the 5 level labels must not appear.
    expect(frame).not.toContain("▸ low ◂");
    expect(frame).not.toContain("手动档位");
  });

  test("档位面板不含开关标签（ON/OFF 不可见，纯档位）", async () => {
    const frame = await renderPickerText({
      kind: "effort",
      focusedIndex: 0,
      currentIndex: 0,
      autoOn: false,
    });
    // The effort panel always has thinking on: ON/OFF switch labels must not appear.
    expect(frame).not.toContain("ON");
    expect(frame).not.toContain("OFF");
    expect(frame).not.toContain("思考已开启");
    expect(frame).not.toContain("思考已关闭");
  });
});

// -- app-layer integration (dual panel + fix without exiting) -------------------

/**
 * Drive the picker end-to-end with a real TuiApp + stub bridge.
 *
 * Why not renderPickerText's standalone renderer: panel interaction (/thinking
 * opens -> key routing -> commit writes state) must go through app.tsx's
 * useKeyboard short-circuit, so mount TuiApp.
 */
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

interface AppDriver {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressSpace: () => Promise<void>;
  readonly pressTab: () => Promise<void>;
  readonly pressLeft: () => Promise<void>;
  readonly pressRight: () => Promise<void>;
  readonly pressCtrlC: () => Promise<void>;
  readonly pressCtrlO: () => Promise<void>;
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0],
  height = 30
): Promise<AppDriver> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-tp-app-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps(responses),
    inflight: createInflightRegistry(),
  });
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
    { width: 80, height, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
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
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressSpace: async () => {
      setup.mockInput.pressKey(" ");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressTab: async () => {
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressLeft: async () => {
      setup.mockInput.pressArrow("left");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressRight: async () => {
      setup.mockInput.pressArrow("right");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressCtrlC: async () => {
      setup.mockInput.pressCtrlC();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressCtrlO: async () => {
      setup.mockInput.pressKey("o", { ctrl: true });
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("thinking-picker app 集成（双面板 + Enter 固定不退出）", () => {
  test("#13 /thinking Enter → 开关面板打开（标题「思考开关」+ OFF 态，默认关）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/thinking");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    // defaultThinking unset -> thinkingEnabled=false -> switch panel seeds OFF.
    expect(frame).toContain("OFF");
    expect(frame).toContain("思考已关闭");
    await app.destroy();
  }, 30_000);

  test("#14 开关面板 Space 切换 + Enter 不关闭 → Esc 保存退出写 enabled → /info adaptive (auto)", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考开关"), 8000, "open");

    // Space: OFF -> ON (◑→◐ dot lights up).
    await app.pressSpace();
    await untilFrame(app.setup, (f) => f.includes("ON"), 8000, "preview-on");

    // Enter: fixes the current preview ON (no toggle, panel stays open -- the
    // core new assertion: Enter neither closes the panel nor toggles the
    // switch, it only "selects and fixes").
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考开关");
    expect(afterEnter).toContain("ON");

    // Esc: save-and-exit (writes thinkingEnabled=true), panel closes.
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考开关"), 8000, "closed");

    // /info reflection: enabled=true + effort="" -> adaptive (auto).
    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("adaptive") && f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("adaptive (auto)");
    await app.destroy();
  }, 30_000);

  test("#15 档位面板 →→ + Enter 固定不关闭 → Esc 保存退出写 high → /info adaptive (high)", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /effort low -> effort panel opens already fixed on low (seed focus=fixed=low).
    await app.typeText("/effort low");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    expect(app.setup.captureCharFrame()).toContain("▸ low ◂");

    // →→: 0 (low) -> 1 (medium) -> 2 (high); Enter fixes high, panel stays open.
    await app.pressRight();
    await app.pressRight();
    await untilFrame(app.setup, (f) => f.includes("▸ high ◂"), 8000, "focus");
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考强度");
    expect(afterEnter).toContain("high");

    // Esc: save-and-exit (writes thinkingEffort=high + implicit enabled), panel closes.
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考强度"), 8000, "closed");

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("adaptive") && f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("adaptive (high)");
    await app.destroy();
  }, 30_000);

  test("#15b /effort 无参（当前 auto）→ 打开自适应面板 → Esc 保存退出保持 auto（不降级）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /effort with no arg + thinkingEffort="" -> panel opens showing auto state
    // (AUTO with the adaptive label; 5 levels greyed with no cursor).
    await app.typeText("/effort");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    const open = app.setup.captureCharFrame();
    expect(open).toContain("自适应");
    expect(open).toContain("AUTO");
    expect(open).not.toContain("▸");

    // Esc save-and-exit: auto state -> writes thinkingEffort="" + implicit
    // enabled (stays auto, no silent downgrade to medium).
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考强度"), 8000, "closed");

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("adaptive") && f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("adaptive (auto)");
    await app.destroy();
  }, 30_000);

  test("#15c /effort 无参 auto 态 Tab 切回手动 → Esc 保存退出写 concrete 档", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /effort with no arg + thinkingEffort="" -> panel opens in auto state.
    await app.typeText("/effort");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    expect(app.setup.captureCharFrame()).toContain("自适应");

    // Tab: auto -> manual level select (grey-out disappears, cursor returns to seed=medium ▸ medium ◂).
    await app.pressTab();
    await untilFrame(
      app.setup,
      (f) => f.includes("▸ medium ◂"),
      8000,
      "manual"
    );
    expect(app.setup.captureCharFrame()).not.toContain("自适应");

    // Esc save-and-exit: manual state writes the fixed concrete level (seed=medium -> medium).
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考强度"), 8000, "closed");

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("adaptive") && f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("adaptive (medium)");
    await app.destroy();
  }, 30_000);

  test("#16 开关面板 Esc 保存退出：未切换也写 OFF → /info thinking: off", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考开关"), 8000, "open");

    // Esc with no toggle at all -> save-and-exit (no cancel path), panel closes.
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考开关"), 8000, "closed");

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("thinking: off");
    await app.destroy();
  }, 30_000);

  test("#19 开关面板打开时 Ctrl+O → 折叠/展开不被吞", async () => {
    // Tall terminal (60 rows): after the picker opens, the chrome budget eats
    // 8 rows, so the viewport still needs enough height to hold the message
    // area's thinking-fold line / expanded thinking full text.
    const app = await mountAppAsync(
      [
        assistantResult({
          texts: ["正式回答"],
          thinkingBlocks: [{ type: "thinking", thinking: "链上推理" }],
        }),
      ],
      60
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));
    // Run one turn to get a committed message with a thinking block.
    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("正式回答"), 8000, "reply");
    // Collapsed: thinking full text not visible.
    let frame = app.setup.captureCharFrame();
    expect(frame.includes("[思考]")).toBe(false);
    expect(frame).not.toContain("链上推理");

    // Open the switch panel + Ctrl+O -> fold toggles (thinking full text expands into view).
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考开关"), 8000, "open");
    await app.pressCtrlO();
    frame = await untilFrame(
      app.setup,
      (f) => f.includes("链上推理"),
      8000,
      "fold-expanded"
    );
    expect(frame).toContain("思考开关"); // panel still open (Ctrl+O neither swallows the key nor closes the panel)

    // Ctrl+O again -> fold back (full text hidden, does not fall back to the thinking-fold marker).
    await app.pressCtrlO();
    frame = await untilFrame(
      app.setup,
      (f) => f.includes("正式回答") && !f.includes("链上推理"),
      8000,
      "fold-collapsed"
    );
    expect(frame.includes("[思考]")).toBe(false);
    expect(frame).toContain("思考开关"); // panel still open
    await app.destroy();
  }, 30_000);

  test("#20 开关面板打开时 Ctrl+C → 不被吞（Ctrl 组合优先，面板仍在）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考开关"), 8000, "open");

    // Ctrl+C: no selection -> copy hint `无选区：先按住鼠标左键拖选文本…` ("no selection: drag-select with the left mouse button first…")
    // ("no selection: hold left mouse button and drag to select text…"), and
    // the panel does not close (Ctrl+C is now pure copy, after the keybinding
    // migration).
    await app.pressCtrlC();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("无选区"),
      8000,
      "copy-hint"
    );
    expect(frame).toContain("思考开关"); // picker branch does not swallow ctrl combos
    await app.destroy();
  }, 30_000);
});
