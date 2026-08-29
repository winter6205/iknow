/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-picker.test.tsx
 *
 * design-25 thinking-picker（双面板版）T1 + T2 测试：
 *  - effortToIndex / indexToEffort SSOT 映射（5 档 concrete + "" 往返幂等、
 *    越界兜底）；
 *  - THINKING_LEVELS 复用 slash.ts ADJUSTABLE_EFFORT_LEVELS（同引用，不重复定义）；
 *  - reduceThinkingSwitchKey 键路由纯函数（开关面板：toggle / commit / ignore）；
 *  - reduceThinkingEffortKey 键路由纯函数（档位面板：move clamp / fix / commit）；
 *  - ThinkingPicker 渲染 smoke（T2，design-25 视觉）——用真实
 *    createCliRenderer（memory buffered）+ getRealCharBytes 抓纯文本，
 *    不用 testRender（animated box 在 testRender 下首帧空白，见本分支
 *    design-25 验证记录）。
 *  - app 层集成：/thinking 打开开关面板（Enter 固定不关闭 / Esc 保存退出写
 *    state）；/effort <level> 打开档位面板（移档 + Enter 固定不关闭 / Esc 保存
 *    退出写 state）。
 *
 * 纯函数单测无需 OpenTUI mock；渲染 smoke 需真实渲染器（Linux bun）。
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

// -- effortToIndex / indexToEffort（SSOT 映射） ---------------------------------

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
    // /effort 打开、默认 effort="" → 展示聚焦 medium → Enter 固定 medium
    expect(indexToEffort(effortToDisplayIndex(""))).toBe("medium");
  });

  test("THINKING_LEVELS 复用 slash.ts ADJUSTABLE_EFFORT_LEVELS（同引用，顺序一致）", () => {
    expect(THINKING_LEVELS).toBe(ADJUSTABLE_EFFORT_LEVELS);
    expect(THINKING_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

// -- committedThinkingPatch（T3，settings 双向持久化 payload 投影） -----------

describe("committedThinkingPatch（commit payload 投影）", () => {
  test("thinking 面板 enabled=true → { thinking: 'adaptive' } 且无 effort 键", () => {
    const patch = committedThinkingPatch({ kind: "thinking", enabled: true });
    expect(patch).not.toBeNull();
    expect(patch!.thinking).toBe("adaptive");
    expect("thinkingEffort" in patch!).toBe(false); // 开关面板不碰档位（记忆保留）
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
    // 五档全跑：currentIndex 才是 Enter 固定后的 committed 档（Esc 保存退出
    // 写它），focusedIndex 只是移动中预览不参与投影。
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (let i = 0; i < levels.length; i++) {
      expect(
        committedThinkingPatch({
          kind: "effort",
          focusedIndex: 2, // 与 committed 分离：焦点不代表已提交档
          currentIndex: i,
          autoOn: false,
        })
      ).toEqual({ thinking: "adaptive", thinkingEffort: levels[i] });
    }
  });

  test("当前判别联合下 null 分支不可达（防御）", () => {
    // ThinkingPickerState 只有 kind:"thinking" | "effort" 两变体，default 分支
    // 只在未来新增变体时触发——用类型断言把未知 kind 喂进去验证兜底语义。
    const unreachable = {
      kind: "future-kind",
    } as unknown as ThinkingPickerState;
    expect(committedThinkingPatch(unreachable)).toBeNull();
  });
});

// -- reduceThinkingSwitchKey（开关面板：Space/Tab toggle · Enter fix · Esc commit） ---

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

// -- reduceThinkingEffortKey（档位面板：←/→ move clamp · Space/Tab toggleAuto ·
//    Enter fix · Esc commit）-

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

// -- ThinkingPicker 渲染 smoke（T2，design-25 视觉，真实渲染器） ---------------

/** 测试专用 stdout（Writable + isTTY + columns/rows），不碰 process.stdout。 */
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

/** 打开 memory-buffered 真实渲染器并挂载 ThinkingPicker，返回一帧纯文本。 */
async function renderPickerText(
  state: ThinkingPickerState,
  cols = 80
): Promise<string> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
    await renderer.loop();
    const bytes = renderer.currentRenderBuffer.getRealCharBytes(true);
    return new TextDecoder().decode(bytes);
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    // 断言失败也要恢复全局，避免污染后续用例（review Low#5）
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** 帧中「任一物理行同时含 [Esc] 与 保存退出」——hint 在窄终端可能折行，
 *  [Esc 保存退出] 不保证同一行连续出现；放宽为跨行存在性断言。 */
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
    expect(frame).toContain("◐"); // 开启圆点亮起
    expect(frame).not.toContain("█"); // 纯开关面板无进度条（用户点名）
    expect(frame).toContain("╭"); // 圆角边框顶
    expect(frame).toContain("╰"); // 圆角边框底
  });

  test("开关面板 OFF：OFF + 思考已关闭，无进度条", async () => {
    const frame = await renderPickerText({ kind: "thinking", enabled: false });
    expect(frame).toContain("思考开关");
    expect(frame).toContain("OFF");
    expect(frame).toContain("思考已关闭");
    expect(frame).toContain("◑"); // 关闭圆点熄灭
    expect(frame).not.toContain("█"); // 纯开关面板无进度条
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
    expect(frame).toContain("█"); // 档位面板保留进度条
    expect(frame).toContain("╭"); // 圆角边框顶
    expect(frame).toContain("╰"); // 圆角边框底
  });

  test("档位面板：焦点游标与已固定档分离（focus 与 committed 并存）", async () => {
    const frame = await renderPickerText({
      kind: "effort",
      focusedIndex: 3,
      currentIndex: 1,
      autoOn: false,
    });
    // 焦点游标在 xhigh（移动中预览），已固定档 medium 也同时提亮。
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
      expect(frame).toContain(label); // 5 档标签仍在（灰显展示）
    }
    expect(frame).not.toContain("▸"); // auto 态无焦点游标
    expect(frame).toContain("█"); // 进度条仍在（整条暗灰轨）
  });

  test("面板固定宽：cols 变化不影响面板宽度，且靠左对齐（不占满屏宽）", async () => {
    // PICKER_WIDTH 固定 + alignSelf flex-start → 面板宽不随终端 cols 变，
    // 且贴左缘（顶行以圆角 ╭ 开头）。getRealCharBytes 会把帧每行 pad 到终端
    // 宽，故用 trimEnd 后的真实面板宽断言。
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
    // 靠左对齐：顶行以圆角边框起点 ╭ 开头（非空白前置填充）。
    expect(topNarrow!.startsWith("╭")).toBe(true);
    // 不占满屏宽：真实面板宽 < 终端 cols。
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
    expect(frameHasSaveEscHint(effortAuto)).toBe(true); // auto 态 hint 同物理行
  });

  test("开关面板不含档位标签（低/中/高档名不可见，纯开关）", async () => {
    const frame = await renderPickerText({ kind: "thinking", enabled: true });
    // 开关面板是纯 ON/OFF：5 档标签不应出现。
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
    // 档位面板必开思考：ON/OFF 开关标签不应出现。
    expect(frame).not.toContain("ON");
    expect(frame).not.toContain("OFF");
    expect(frame).not.toContain("思考已开启");
    expect(frame).not.toContain("思考已关闭");
  });
});

// -- app 层集成（T3，双面板 + 固定不退出） -----------------------------------

/**
 * 用真实 TuiApp + stub bridge 跑 picker 端到端。
 *
 * 为什么不用 renderPickerText 的独立渲染器：面板交互（/thinking 打开 → 键路由
 * → commit 写 state）必须走 app.tsx 的 useKeyboard 短路，用 TuiApp mount。
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
    // defaultThinking 未设 → thinkingEnabled=false → 开关面板 seed OFF。
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

    // Space：OFF → ON（◑→◐ 圆点亮起）。
    await app.pressSpace();
    await untilFrame(app.setup, (f) => f.includes("ON"), 8000, "preview-on");

    // Enter：固定当前预览 ON（不翻转、面板保持打开——核心新增断言：Enter 不
    // 关闭面板，也不翻转开关，仅"选定固定"）。
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考开关");
    expect(afterEnter).toContain("ON");

    // Esc：保存退出（写 thinkingEnabled=true），面板关闭。
    await app.pressEscape();
    await untilFrame(app.setup, (f) => !f.includes("思考开关"), 8000, "closed");

    // /info 反射：enabled=true + effort="" → adaptive (auto)。
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

    // /effort low → 档位面板打开并直接固定 low（seed focus=fixed=low）。
    await app.typeText("/effort low");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    expect(app.setup.captureCharFrame()).toContain("▸ low ◂");

    // →→：0 (low) → 1 (medium) → 2 (high)；Enter 固定 high，面板保持打开。
    await app.pressRight();
    await app.pressRight();
    await untilFrame(app.setup, (f) => f.includes("▸ high ◂"), 8000, "focus");
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考强度");
    expect(afterEnter).toContain("high");

    // Esc：保存退出（写 thinkingEffort=high + 隐式 enabled），面板关闭。
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

    // /effort 无参 + thinkingEffort="" → 面板打开并呈现自适应态（AUTO · 自适应，
    // 5 档灰显无光标）。
    await app.typeText("/effort");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    const open = app.setup.captureCharFrame();
    expect(open).toContain("自适应");
    expect(open).toContain("AUTO");
    expect(open).not.toContain("▸");

    // Esc 保存退出：auto 态 → 写 thinkingEffort="" + 隐式 enabled（保持 auto，
    // 不静默降 medium）。
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

    // /effort 无参 + thinkingEffort="" → 面板打开呈自适应态。
    await app.typeText("/effort");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考强度"), 8000, "open");
    expect(app.setup.captureCharFrame()).toContain("自适应");

    // Tab：auto → 手动选档（面板灰显消失，焦点游标回到 seed=medium ▸ medium ◂）。
    await app.pressTab();
    await untilFrame(
      app.setup,
      (f) => f.includes("▸ medium ◂"),
      8000,
      "manual"
    );
    expect(app.setup.captureCharFrame()).not.toContain("自适应");

    // Esc 保存退出：手动态写已固定 concrete 档（seed=medium → medium）。
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

    // 无任何切换直接 Esc → 保存退出（无 cancel 路径），面板关闭。
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
    // 高终端（60 行）：picker 打开后 chrome 预算吃掉 8 行，viewport 仍需足够
    // 高度容纳消息区 [思考] 折叠行 / 展开的 thinking 全文。
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
    // 走一轮 turn 拿到含 thinking 块的 committed 消息。
    await app.typeText("hi");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("正式回答"), 8000, "reply");
    // 折叠态：思考全文不可见。
    let frame = app.setup.captureCharFrame();
    expect(frame.includes("[思考]")).toBe(false);
    expect(frame).not.toContain("链上推理");

    // 打开开关面板 + Ctrl+O → 折叠态翻转（思考全文展开可见）。
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
    expect(frame).toContain("思考开关"); // 面板仍在（Ctrl+O 未吞键也未关面板）

    // 再 Ctrl+O → 折叠回去（全文不可见，不回落 [思考]）。
    await app.pressCtrlO();
    frame = await untilFrame(
      app.setup,
      (f) => f.includes("正式回答") && !f.includes("链上推理"),
      8000,
      "fold-collapsed"
    );
    expect(frame.includes("[思考]")).toBe(false);
    expect(frame).toContain("思考开关"); // 面板仍在
    await app.destroy();
  }, 30_000);

  test("#20 开关面板打开时 Ctrl+C → 不被吞（Ctrl 组合优先，面板仍在）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("思考开关"), 8000, "open");

    // Ctrl+C：idle 无前台 turn → notice「无前台运行中的 turn」，且面板不关。
    await app.pressCtrlC();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("Ctrl+C"),
      8000,
      "ctrl-c"
    );
    expect(frame).toContain("思考开关"); // picker 分支不吞 ctrl 组合键
    await app.destroy();
  }, 30_000);
});
