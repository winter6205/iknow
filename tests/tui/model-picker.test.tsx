/** @jsxImportSource @opentui/react */
/**
 * tests/tui/model-picker.test.tsx
 *
 * /model 模型选择面板：reducer 纯函数 + 行账 + design-25 渲染 smoke。
 *
 * 键位语义（spec SC8 + Glossary「/model(TUI)」条）：↑/↓ 移焦点（clamp）、
 * Enter 选定、Esc 关闭（无 cancel/放弃路径 —— 焦点移动不产生 staged 状态，
 * 故 Esc 既非「保存退出」也非「放弃修改」）、Space/Tab/←→ 忽略。
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { act } from "react";
import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  MODEL_PICKER_MAX_ROWS,
  ModelPicker,
  modelPickerRows,
  modelRouteId,
  reduceModelPickerKey,
  type ModelPickerEntry,
  type ModelPickerState,
} from "../../src/tui/model-picker.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";
import { PICKER_WIDTH } from "../../src/tui/thinking-picker.js";

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

function entry(providerId: string, modelId: string, label?: string) {
  return { providerId, modelId, ...(label !== undefined ? { label } : {}) };
}

describe("modelRouteId", () => {
  test("provider/model 拼接（持久化值 + 列表主标签同源）", () => {
    expect(modelRouteId(entry("minimax-cn", "MiniMax-M3"))).toBe(
      "minimax-cn/MiniMax-M3"
    );
  });
});

describe("reduceModelPickerKey", () => {
  const three = { focusedIndex: 0, entryCount: 3 };

  test("↓ 焦点 +1（面板保持打开）", () => {
    expect(reduceModelPickerKey(key({ downArrow: true }), three)).toEqual({
      kind: "move",
      index: 1,
    });
  });

  test("↑ 焦点 -1", () => {
    expect(
      reduceModelPickerKey(key({ upArrow: true }), {
        focusedIndex: 2,
        entryCount: 3,
      })
    ).toEqual({ kind: "move", index: 1 });
  });

  test("↓ 已在末项 → clamp 到 entryCount-1", () => {
    expect(
      reduceModelPickerKey(key({ downArrow: true }), {
        focusedIndex: 2,
        entryCount: 3,
      })
    ).toEqual({ kind: "move", index: 2 });
  });

  test("↑ 已在首项 → clamp 到 0", () => {
    expect(reduceModelPickerKey(key({ upArrow: true }), three)).toEqual({
      kind: "move",
      index: 0,
    });
  });

  test("单条注册表：↑↓ 均 clamp 0", () => {
    const one = { focusedIndex: 0, entryCount: 1 };
    expect(reduceModelPickerKey(key({ downArrow: true }), one)).toEqual({
      kind: "move",
      index: 0,
    });
    expect(reduceModelPickerKey(key({ upArrow: true }), one)).toEqual({
      kind: "move",
      index: 0,
    });
  });

  test("空注册表：↑↓ 恒 0（不为负、不越界）", () => {
    const empty = { focusedIndex: 0, entryCount: 0 };
    expect(reduceModelPickerKey(key({ downArrow: true }), empty)).toEqual({
      kind: "move",
      index: 0,
    });
    expect(reduceModelPickerKey(key({ upArrow: true }), empty)).toEqual({
      kind: "move",
      index: 0,
    });
  });

  test("Enter → fix（选定焦点项，由宿主持久化 + reloadFromEnv + 关闭）", () => {
    expect(reduceModelPickerKey(key({ return: true }), three)).toEqual({
      kind: "fix",
    });
  });

  test("Esc → commit（关闭，不产生任何写入）", () => {
    expect(reduceModelPickerKey(key({ escape: true }), three)).toEqual({
      kind: "commit",
    });
  });

  test("Space / Tab / ← / → → ignore（无 toggle、无横移语义）", () => {
    expect(reduceModelPickerKey(key({ space: true }), three)).toEqual({
      kind: "ignore",
    });
    expect(reduceModelPickerKey(key({ tab: true }), three)).toEqual({
      kind: "ignore",
    });
    expect(reduceModelPickerKey(key({ leftArrow: true }), three)).toEqual({
      kind: "ignore",
    });
    expect(reduceModelPickerKey(key({ rightArrow: true }), three)).toEqual({
      kind: "ignore",
    });
  });

  test("ctrl/meta → ignore（Ctrl+C/O 不被吞，让给 app 层路由）", () => {
    expect(
      reduceModelPickerKey({ input: "c", key: { ...noKey, ctrl: true } }, three)
    ).toEqual({ kind: "ignore" });
    expect(
      reduceModelPickerKey({ input: "o", key: { ...noKey, meta: true } }, three)
    ).toEqual({ kind: "ignore" });
  });

  test("可打印字符 → ignore（不设 hotkey 直选）", () => {
    expect(
      reduceModelPickerKey({ input: "m", key: { ...noKey } }, three)
    ).toEqual({ kind: "ignore" });
  });

  test("ctrl 修饰的方向键仍 ignore（ctrl 优先于方向判定）", () => {
    expect(
      reduceModelPickerKey(
        { input: "", key: { ...noKey, ctrl: true, downArrow: true } },
        three
      )
    ).toEqual({ kind: "ignore" });
  });

  test("注册表 ≥13 条：焦点恒在可见窗口内（↓ 到底不越界，游标不会走出渲染区）", () => {
    // 渲染只出前 MODEL_PICKER_MAX_ROWS 项（13 条时第 13 项只在「…1 more」
    // 计数里）。若 clamp 用 entryCount-1，一路按 ↓ 会把游标推到渲染区外 ——
    // 看不见焦点，Enter 却作用在它上面。逐次按键走一遍并逐步校验。
    const visible = MODEL_PICKER_MAX_ROWS; // 可见条目数（= 窗口上界）
    let index = 0;
    for (let i = 0; i < 20; i++) {
      const action = reduceModelPickerKey(key({ downArrow: true }), {
        focusedIndex: index,
        entryCount: 13,
      });
      expect(action.kind).toBe("move");
      index = action.kind === "move" ? action.index : index;
      // 两条不变式：不越出可见窗口（游标有处可画）+ 指向的条目确实被渲染。
      expect(index).toBeLessThan(visible);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    // 走到底停在窗口末项（11），而非隐藏的第 13 项（12）。
    expect(index).toBe(visible - 1);
    // 窗口外 seed（当前 model 正好是隐藏项）→ 任一方向键把焦点拉回可见区末项
    // （clamp 幂等：越界下标无论从哪个方向按都停在窗口边缘）。
    for (const arrow of [{ downArrow: true }, { upArrow: true }] as const) {
      expect(
        reduceModelPickerKey(key(arrow), { focusedIndex: 12, entryCount: 13 })
      ).toEqual({ kind: "move", index: visible - 1 });
    }
    // 空 / 单条注册表仍恒 0（窗口上界 ≥ 0，不为负）。
    for (const entryCount of [0, 1]) {
      expect(
        reduceModelPickerKey(key({ downArrow: true }), {
          focusedIndex: 0,
          entryCount,
        })
      ).toEqual({ kind: "move", index: 0 });
    }
  });
});

describe("modelPickerRows（行账）", () => {
  // 逐项列账：边框 2 + 标题 1 + 内容行 + 键位提示 1（与 memoryPickerRows 同款）。
  const CHROME = 2 + 1 + 1;

  test("1 条 → 边框 2 + 标题 1 + 内容 1 + 键位提示 1", () => {
    expect(modelPickerRows(1)).toBe(CHROME + 1);
  });

  test("3 条 → 内容随条数线性增长", () => {
    expect(modelPickerRows(3)).toBe(CHROME + 3);
    expect(modelPickerRows(3) - modelPickerRows(1)).toBe(2);
  });

  test("恰在上限 12 条 → 无 overflow 行", () => {
    expect(modelPickerRows(MODEL_PICKER_MAX_ROWS)).toBe(CHROME + 12);
  });

  test("超过上限 13 条 → 「…1 more」占一行（比上限多 1 行）", () => {
    expect(MODEL_PICKER_MAX_ROWS).toBe(12);
    expect(modelPickerRows(13)).toBe(CHROME + 12 + 1);
    expect(modelPickerRows(13)).toBe(
      modelPickerRows(MODEL_PICKER_MAX_ROWS) + 1
    );
  });

  test("注册表 100 条 → 行数仍封顶（不随注册表增长挤爆视图）", () => {
    expect(modelPickerRows(100)).toBe(modelPickerRows(13));
  });

  test("0 条 → 空占位 1 行（产品路径由 notice 拦下不打开面板）", () => {
    expect(modelPickerRows(0)).toBe(CHROME + 1);
  });

  test("行账为逐项尺寸：1 条 = 边框 2 + 标题 1 + 内容 1 + overflow 0 + 提示 1 = 5", () => {
    // 钉住真实分解值（非 CHROME 派生式）：marginBottom=1 由渲染盒声明、不入本
    // 函数 —— 它由 chromeReserveRows 的 pickerRows 槽 +1 入账（tests/tui/
    // chrome-budget.test.ts），故本值必须是 5 而非 6。
    expect(modelPickerRows(1)).toBe(5);
    expect(modelPickerRows(13)).toBe(13 - 12 + modelPickerRows(12));
  });
});

// -- 渲染 smoke（design-25 视觉，真实渲染器） ---------------------------------

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

/** 打开 memory-buffered 真实渲染器并挂载 ModelPicker，返回一帧纯文本。 */
async function renderPickerText(
  state: ModelPickerState,
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
      root.render(<ModelPicker state={state} />);
    });
    await renderer.loop();
    const bytes = renderer.currentRenderBuffer.getRealCharBytes(true);
    return new TextDecoder().decode(bytes);
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

const THREE: ReadonlyArray<ModelPickerEntry> = [
  entry("minimax-cn", "MiniMax-M3", "MiniMax M3"),
  entry("volcengine-ark", "deepseek-v3-250324", "DeepSeek V3"),
  entry("volcengine-ark", "doubao-pro-256k"),
];

describe("ModelPicker 渲染（design-25 视觉 smoke）", () => {
  test("标题「模型」+ 每项 provider/model 行 + 圆角边框", async () => {
    const frame = await renderPickerText({
      entries: THREE,
      focusedIndex: 0,
    });
    expect(frame).toContain("模型");
    expect(frame).toContain("minimax-cn/MiniMax-M3");
    expect(frame).toContain("volcengine-ark/deepseek-v3-250324");
    expect(frame).toContain("volcengine-ark/doubao-pro-256k");
    expect(frame).toContain("╭"); // 圆角边框顶
    expect(frame).toContain("╰"); // 圆角边框底
  });

  test("label 存在时附显示名；缺省时只渲染路由 ID", async () => {
    const frame = await renderPickerText({
      entries: [entry("minimax-cn", "MiniMax-M3", "MiniMax M3")],
      focusedIndex: 0,
    });
    expect(frame).toContain("MiniMax M3");
    const bare = await renderPickerText({
      entries: [entry("minimax-cn", "MiniMax-M3")],
      focusedIndex: 0,
    });
    expect(bare).toContain("minimax-cn/MiniMax-M3");
  });

  test("焦点游标 ▸ 落在 focusedIndex 行（其余行两空格前缀）", async () => {
    const frame = await renderPickerText({
      entries: THREE,
      focusedIndex: 1,
    });
    const focusedLine = frame
      .split("\n")
      .find((l) => l.includes("deepseek-v3-250324"));
    expect(focusedLine).toBeDefined();
    expect(focusedLine).toContain("▸ ");
    // 焦点只此一处：其余条目行不带游标。
    const cursorLines = frame
      .split("\n")
      .filter((l) => l.includes("▸ ") && l.includes("/"));
    expect(cursorLines.length).toBe(1);
  });

  test("键位提示行披露 ↑↓ 选择 / Enter 切换 / Esc 关闭", async () => {
    const frame = await renderPickerText({
      entries: THREE,
      focusedIndex: 0,
    });
    const hintLine = frame.split("\n").find((l) => l.includes("[↑↓]"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("[Enter]");
    expect(hintLine).toContain("[Esc]");
  });

  test("超过上限：只渲染前 12 项 + 「…N more」一行（面板行数封顶）", async () => {
    const many: ModelPickerEntry[] = [];
    for (let i = 0; i < 15; i++) {
      many.push(entry("prov", `model-${i}`));
    }
    const frame = await renderPickerText({ entries: many, focusedIndex: 0 });
    expect(frame).toContain("prov/model-11");
    expect(frame).not.toContain("prov/model-12");
    expect(frame).toContain("…3 more");
  });

  test("面板固定宽 PICKER_WIDTH 且靠左对齐（不占满屏宽）", async () => {
    const narrow = await renderPickerText(
      { entries: THREE, focusedIndex: 0 },
      60
    );
    const wide = await renderPickerText(
      { entries: THREE, focusedIndex: 0 },
      120
    );
    const topNarrow = narrow.split("\n").find((l) => l.includes("╭"));
    const topWide = wide.split("\n").find((l) => l.includes("╭"));
    expect(topNarrow).toBeDefined();
    expect(topWide).toBeDefined();
    expect(topNarrow!.trimEnd().length).toBe(topWide!.trimEnd().length);
    expect(topNarrow!.trimEnd().length).toBe(PICKER_WIDTH);
    expect(topNarrow!.startsWith("╭")).toBe(true);
  });
});
