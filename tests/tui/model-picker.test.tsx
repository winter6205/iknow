/** @jsxImportSource @opentui/react */
/**
 * tests/tui/model-picker.test.tsx
 *
 * /model picker panel: reducer pure functions + row accounting + render smoke.
 *
 * Key semantics (Glossary 「/model(TUI)」 entry): ↑/↓ move focus (clamp),
 * Enter selects, Esc closes (no cancel/discard path — focus moves stage
 * nothing, so Esc is neither "save and quit" nor "discard changes"),
 * Space/Tab/←→ ignored.
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
import { flushRendererFrame, setReactActEnvironment } from "./_fixtures.tsx";
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
    // only the first MODEL_PICKER_MAX_ROWS entries render (with 13 entries the
    // 13th only appears in the "…1 more" counter). If clamp used
    // entryCount-1, holding ↓ would push the cursor out of the rendered area —
    // invisible focus that Enter still commits. Step through keys and check each move.
    const visible = MODEL_PICKER_MAX_ROWS; // rendered entry count (= window upper bound)
    let index = 0;
    for (let i = 0; i < 20; i++) {
      const action = reduceModelPickerKey(key({ downArrow: true }), {
        focusedIndex: index,
        entryCount: 13,
      });
      expect(action.kind).toBe("move");
      index = action.kind === "move" ? action.index : index;
      // two invariants: never leave the visible window (cursor has a place to draw) + the pointed entry is actually rendered.
      expect(index).toBeLessThan(visible);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    // walking to the bottom stops at the window's last item (11), not the hidden 13th (12).
    expect(index).toBe(visible - 1);
    // seeding outside the window (current model happens to be hidden) → any
    // arrow pulls focus back to the window's last item (clamp is idempotent:
    // an out-of-range index stops at the window edge from either direction).
    for (const arrow of [{ downArrow: true }, { upArrow: true }] as const) {
      expect(
        reduceModelPickerKey(key(arrow), { focusedIndex: 12, entryCount: 13 })
      ).toEqual({ kind: "move", index: visible - 1 });
    }
    // empty / single-entry registries still pin to 0 (window upper bound ≥ 0, never negative).
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
  // itemized accounting: borders 2 + title 1 + content rows + key hint 1 (same shape as memoryPickerRows).
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
    // pin the real decomposed value (not a CHROME-derived formula):
    // marginBottom=1 is declared by the render box and excluded from this
    // function — it is accounted by chromeReserveRows' pickerRows slot +1
    // (tests/tui/chrome-budget.test.ts), so this value must be 5, not 6.
    expect(modelPickerRows(1)).toBe(5);
    expect(modelPickerRows(13)).toBe(13 - 12 + modelPickerRows(12));
  });
});

// -- render smoke (real renderer) ------------------------------------------------

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

/** Open a memory-buffered real renderer, mount ModelPicker, return one plain-text frame. */
async function renderPickerText(
  state: ModelPickerState,
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
      root.render(<ModelPicker state={state} />);
    });
    await flushRendererFrame(renderer);
    const bytes = renderer.currentRenderBuffer.getRealCharBytes(true);
    return new TextDecoder().decode(bytes);
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    setReactActEnvironment(false);
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
    expect(frame).toContain("╭"); // rounded border top
    expect(frame).toContain("╰"); // rounded border bottom
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
    // focus exists in exactly one place: no other entry line carries the cursor.
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
