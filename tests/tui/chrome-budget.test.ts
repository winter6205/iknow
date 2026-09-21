/**
 * tests/tui/chrome-budget.test.ts
 *
 * Unit tests for the pure functions chromeReserveRows + noticeRenderRows
 * (the line-accounting SSOT). They own the per-item budget logic for
 * viewportRows; any new bottom line must be accounted here.
 *
 *  - chromeReserveRows: headroom 1 + mode 1 + input box (dynamic
 *    inputRows) + hint + ContextBar 1 + ask 1 + notice (rows + 1) + modal
 *    (rows + 1) + bgLine; plus agentStatusRows (live agent status, 0-6 rows
 *    dynamic, default 0 — zero impact on baseline cases; see
 *    agent-status-panel.test.ts).
 *  - noticeRenderRows: line count after empty / empty-string / multi-line /
 *    visual-width wrapping.
 *  - compactProgressRows (/compact progress panel, 6 rows) is its own
 *    section: compactRows defaults to 0 — zero impact on baseline cases and
 *    old callers.
 *
 * The input-box line count moved from a fixed 3 to dynamic `inputRows`
 * (default: 1 content row + 2 rounded-border rows). inputRows default = 1 →
 * 3 (same as the old fixed value); with 5-row / 8-row input (maxLines cap)
 * the budget grows accordingly — the viewport shrinks with it instead of
 * squeezing out history.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bgStatusLine,
  chromeReserveRows,
  inputVisibleLineCount,
  inputWrapLineCount,
  noticeRenderRows,
} from "../../src/tui/app.js";
import { thinkingPickerRows } from "../../src/tui/thinking-picker.js";
import { memoryPickerRows } from "../../src/tui/memory-picker.js";
import { configPickerRows } from "../../src/tui/config-panel.js";
import { compactProgressRows } from "../../src/tui/compact-progress.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("chromeReserveRows", () => {
  test("最小场景：no notice / no hint / no bg / no modal = 7 行（headroom+mode+input+ctx+ask）", () => {
    const rows = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(rows).toBe(1 + 1 + 3 + 0 + 1 + 1);
  });

  test("有 bg：+1 行", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withBg = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: true,
      inputRows: 1,
    });
    expect(withBg - base).toBe(1);
  });

  test("有 hint：hintRows 计入", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withHint = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 3,
      bgLine: false,
      inputRows: 1,
    });
    expect(withHint - base).toBe(3);
  });

  test("有 notice：noticeRows + 1（marginBottom）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withNotice = chromeReserveRows({
      noticeRows: 2,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(withNotice - base).toBe(3);
  });

  test("有 modal：modalRows + 1（marginBottom）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withModal = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      modalRows: 5,
    });
    expect(withModal - base).toBe(6);
  });

  test("全部叠加：bg + hint + notice + modal 一并入账", () => {
    const rows = chromeReserveRows({
      noticeRows: 2,
      inputHintRows: 3,
      bgLine: true,
      inputRows: 1,
      modalRows: 5,
    });
    expect(rows).toBe(1 + 1 + 3 + 3 + 1 + 1 + 3 + 6 + 1);
  });

  test("modalRows 缺省（undefined）= 0，行为同未传", () => {
    const a = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const b = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      modalRows: undefined,
    });
    expect(a).toBe(b);
  });

  test("T8：inputRows 缺省 = 1 内容行 → 3（等价旧固定值 1+2 圆角边框）", () => {
    const a = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const b = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(a).toBe(7);
    expect(a).toBe(b);
  });

  test("T8：多行输入 inputRows=5 → 预算 +4（5 内容行 + 2 边框 − 3 基线）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const multi = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 5,
    });
    expect(multi - base).toBe(4);
  });

  test("T8：超过 maxLines（8）→ 高度封顶：inputRows=8 与 =20 同预算", () => {
    const capped = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 8,
    });
    const beyond = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 20,
    });
    expect(capped).toBe(beyond);
    expect(capped - 7).toBe(7); // 8 + 2 − 3
  });
});

describe("inputVisibleLineCount", () => {
  test("空字符串 → 1 行", () => {
    expect(inputVisibleLineCount("")).toBe(1);
  });

  test("单行无换行 → 1 行", () => {
    expect(inputVisibleLineCount("hello")).toBe(1);
  });

  test("含换行 → 按 \\n 物理行数", () => {
    expect(inputVisibleLineCount("a\nb\nc")).toBe(3);
  });

  test("尾部换行 → 空行也计入（a\\nb\\n = 3 行）", () => {
    expect(inputVisibleLineCount("a\nb\n")).toBe(3);
  });

  test("T8：行数严格单调增 —— 高度增长 SSOT 证据（1 → 2 → 3 → 4 → 5）", () => {
    // The chromeReserveRows budget grows strictly with
    // inputVisibleLineCount, coupled with textarea height={min(rows, MAX)}
    // → height growth.
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    for (const n of [2, 3, 4, 5]) {
      const expanded = chromeReserveRows({
        noticeRows: 0,
        inputHintRows: 0,
        bgLine: false,
        inputRows: inputVisibleLineCount(Array(n).fill("行").join("\n")),
      });
      expect(expanded - base).toBe(n - 1); // +1 budget per added row
    }
  });

  test("T8：到达 MAX_INPUT_LINES 封顶 —— 内部滚动证据（inputRows=7/8/9/20 同预算）", () => {
    // SSOT evidence for textarea internal scrolling: past
    // MAX_INPUT_LINES (8) the line count stops growing — chromeReserveRows
    // clamps internally with Math.min(..., MAX_INPUT_LINES).
    const a = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 7,
    });
    const b = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 8,
    });
    const c = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 9,
    });
    const d = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 20,
    });
    // 7 → 8 still adds one row; 8 → 9 → 20 cap at the same budget
    // (absorbed by textarea internal scrolling)
    expect(b - a).toBe(1);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });
});

describe("inputWrapLineCount: T9 wrap-aware 输入框行数（修「输入多少都是一行」）", () => {
  test("空字符串 → 1 行", () => {
    expect(inputWrapLineCount("", 80)).toBe(1);
  });

  test("短文本无换行 → 1 行（cols=80）", () => {
    expect(inputWrapLineCount("hello", 80)).toBe(1);
  });

  test("长 ASCII 文本无换行（100 字符，cols=80）→ ceil(100/74)=2 行（innerCols=cols-6）", () => {
    // innerCols = 80 - 6 = 74 (rounded border 2 + paddingX 2 + ❯ 2)
    expect(inputWrapLineCount("x".repeat(100), 80)).toBe(2);
  });

  test("超长 ASCII 文本（300 字符，cols=80）→ ceil(300/74)=5 行", () => {
    expect(inputWrapLineCount("x".repeat(300), 80)).toBe(5);
  });

  test("CJK 按视觉宽度（2 列）折行：50 字 CJK × 2 = 100 视觉列 / 74 = 2 行", () => {
    expect(inputWrapLineCount("测".repeat(50), 80)).toBe(2);
  });

  test("窄终端 cols=20：innerCols=14，长文本 'xxx...' 折多行", () => {
    // 50 ASCII chars / 14 = 4 rows
    expect(inputWrapLineCount("x".repeat(50), 20)).toBe(4);
  });

  test("换行 + 折行混合：'a\\n' + 长行（200 字符，cols=80）→ 1 + ceil(200/74)=1 + 3 = 4", () => {
    expect(inputWrapLineCount("a\n" + "x".repeat(200), 80)).toBe(4);
  });

  test("尾部换行 → 空行也计入（'a\\nb\\n' = 3 行）", () => {
    expect(inputWrapLineCount("a\nb\n", 80)).toBe(3);
  });

  test("cols=0 / cols=5 极端：innerCols 被 Math.max(1,..) 守护为 1", () => {
    expect(inputWrapLineCount("ab", 0)).toBe(2); // innerCols=1 → a=1, b=1
    expect(inputWrapLineCount("a", 5)).toBe(1); // innerCols=1 → 1 line
  });

  test("T9 chrome 联动：长无换行文本 → chromeReserveRows 行账同步增长", () => {
    // 80 ASCII chars at cols=80 → wrap-aware = 2 rows → chrome inputRows=2
    // is 1 more than 1
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const expanded = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: inputWrapLineCount("x".repeat(80), 80),
    });
    expect(expanded - base).toBe(1);
  });
});

describe("noticeRenderRows", () => {
  test("undefined / 空数组 → 0", () => {
    expect(noticeRenderRows(undefined, 80)).toBe(0);
    expect(noticeRenderRows([], 80)).toBe(0);
  });

  test("每条空字符串 → 1 行", () => {
    expect(noticeRenderRows([""], 80)).toBe(1);
  });

  test("单条短行 → 1 行", () => {
    expect(noticeRenderRows(["hello"], 80)).toBe(1);
  });

  test("多行：每条独立折行后行数合计", () => {
    const lines = ["第一行", "第二行", "第三行"];
    expect(noticeRenderRows(lines, 80)).toBe(3);
  });

  test("窄终端：单条长字符串按视觉宽度折多行", () => {
    const long = "这是一个比较长的 notice 文本用来测试折行行为";
    const wide = noticeRenderRows([long], 80);
    const narrow = noticeRenderRows([long], 10);
    expect(narrow).toBeGreaterThan(wide);
    expect(narrow).toBeGreaterThan(1);
  });

  test("cols 极小（<2）→ 仍按物理行数返回（不抛）", () => {
    expect(noticeRenderRows(["abc"], 0)).toBe(1);
    expect(noticeRenderRows(["abc"], 1)).toBe(1);
  });
});

describe("bgStatusLine", () => {
  test("有首条 user 文本 → `后台运行中 · <summary>`（spec #146 SC5）", () => {
    expect(bgStatusLine([userMsg("帮我写一个脚本")])).toBe(
      "后台运行中 · 帮我写一个脚本"
    );
  });

  test("无 user 文本消息 → 回退「后台运行中」（不加尾缀）", () => {
    expect(bgStatusLine([])).toBe("后台运行中");
    expect(
      bgStatusLine([
        { role: "assistant", content: [{ type: "text", text: "x" }] },
      ])
    ).toBe("后台运行中");
  });
});

/**
 * Line accounting for thinkingPickerRows (thinking-picker dual panel).
 *
 * Dispatched by panel kind: the thinking toggle panel is 5 rows (rounded
 * border 2 + content 3: title / status line / key hint, **no progress
 * bar**); the effort-level panel is 7 rows (border 2 + content 5: title /
 * status line / progress bar / level label / key hint). **Excludes
 * marginBottom=1** — same convention as modalRows: marginBottom is
 * accounted by chromeReserveRows' +1.
 */
describe("thinkingPickerRows（design-25 面板行账）", () => {
  test("thinking 开关面板（无进度条）：5 行 = 边框 2 + 内容 3", () => {
    expect(thinkingPickerRows("thinking")).toBe(5);
  });

  test("effort 档位面板（含进度条）：7 行 = 边框 2 + 内容 5", () => {
    expect(thinkingPickerRows("effort")).toBe(7);
  });

  test("thinking 面板 +1 marginBottom = 6 行 delta；effort +1 = 8 行 delta", () => {
    // Consistent with modalRows' `+1` convention (panel marginBottom is
    // accounted by chromeReserveRows).
    expect(thinkingPickerRows("thinking") + 1).toBe(6);
    expect(thinkingPickerRows("effort") + 1).toBe(8);
  });

  test("有 picker：pickerRows + 1（marginBottom，与 modalRows 同款 delta）", () => {
    // pickerRows is folded into the chromeReserveRows budget: thinking 5
    // rows + marginBottom 1 = 6-row delta; effort 7 rows + 1 = 8-row delta.
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(base).toBe(7);
    const withThinking = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: 5,
    });
    expect(withThinking - base).toBe(6);
    const withEffort = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: 7,
    });
    expect(withEffort - base).toBe(8);
  });

  test("pickerRows 缺省（undefined）= 0，行为同未传", () => {
    const a = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const b = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: undefined,
    });
    expect(a).toBe(b);
  });

  // chromeReserveRows still accepts panelRows; the product path always
  // passes 0 — the subagent panel renders below the input box instead of
  // pushing it upward.
  test("panelRows 缺省（undefined / 未传）= 0，不占底部行账", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(base).toBe(7);
    const explicit = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      panelRows: undefined,
    });
    expect(explicit).toBe(base);
  });

  test("panelRows=4 → 预算 +4（底线基准 7 + 4 = 11）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(base).toBe(7);
    const withPanel = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      panelRows: 4,
    });
    expect(withPanel - base).toBe(4);
  });

  // Bottom chrome has no explicit height and defaults to flexShrink=1; when
  // panel rows are unaccounted the total exceeds the terminal → Yoga
  // distributes the negative space proportionally to the input box (always
  // reproducible with >=7 live subagents). Current contract: panelRows =
  // actual collapsed row count (bounded by SUBAGENT_PANEL_MAX_ROWS), equal
  // to the rendered height — the input box shifts up intact.
  test("app 产品路径 panelRows 入账且有界（subagentPanelRows 接线，#1044）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src/tui/app.tsx"),
      "utf8"
    );
    expect(src).toMatch(/panelRows:\s*subagentPanelRows/);
    expect(src).not.toMatch(/panelRows:\s*0/);
  });

  // Agent status line-count accounting (same shape as panelRows: default
  // takes no rows, explicit values are accounted; the component has no
  // marginBottom). Projection cases live in agent-status-panel.test.ts.
  test("agentStatusRows 缺省（undefined）= 0，不占底部行账（基线 7 不变）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const explicit = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      agentStatusRows: undefined,
    });
    const explicitZero = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      agentStatusRows: 0,
    });
    expect(explicit).toBe(base);
    expect(explicitZero).toBe(base);
    expect(base).toBe(7);
  });

  test("agentStatusRows=2（last_tool 行 + 1 未勾项）→ 预算 +2；与其他项叠加", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withStatus = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      agentStatusRows: 2,
    });
    expect(withStatus - base).toBe(2);
    const stacked = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: true,
      inputRows: 1,
      panelRows: 4,
      agentStatusRows: 2,
    });
    expect(stacked).toBe(7 + 2 + 4 + 1);
  });
});

describe("memoryPickerRows（/memory 双开关面板行账）", () => {
  test("6 行 = 边框 2 + 内容 4", () => {
    expect(memoryPickerRows()).toBe(6);
  });

  test("有 memory picker：pickerRows + 1 marginBottom = 7 行 delta", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withMemory = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: memoryPickerRows(),
    });
    expect(withMemory - base).toBe(7);
  });
});

/**
 * Line accounting for compactProgressRows (compaction progress panel).
 *
 * 6 rows = border 2 + content 4 (title / status line / progress bar / key
 * hint), **excludes marginBottom=1** — same convention as pickerRows /
 * modalRows, accounted by chromeReserveRows' +1. Default 0: zero impact on
 * old callers (no compaction panel).
 */
describe("compactProgressRows（compact 进度面板行账）", () => {
  test("6 行 = 边框 2 + 内容 4", () => {
    expect(compactProgressRows()).toBe(6);
  });

  test("有 compact 面板：compactRows + 1 marginBottom = 7 行 delta", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withCompact = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      compactRows: compactProgressRows(),
    });
    expect(base).toBe(7);
    expect(withCompact - base).toBe(7);
  });

  test("compactRows 缺省（undefined）= 0，行为同未传", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const explicit = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      compactRows: undefined,
    });
    expect(explicit).toBe(base);
  });
});

/**
 * ADR-0096 — line accounting for configPickerRows (settings panel).
 *
 * 7 rows = border 2 + title 1 + content 3 (FS isolation tier / worktree
 * gate / subagent concurrency cap) + key hint 1. **Excludes
 * marginBottom=1** — same convention as modelPickerRows /
 * thinkingPickerRows / memoryPickerRows, accounted by chromeReserveRows' +1.
 */
describe("configPickerRows（/config 设置面板行账）", () => {
  test("7 行 = 边框 2 + 标题 1 + 内容 3 + 键位提示 1", () => {
    expect(configPickerRows()).toBe(7);
  });

  test("有 config picker：pickerRows + 1 marginBottom = 8 行 delta", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withConfig = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: configPickerRows(),
    });
    expect(base).toBe(7);
    expect(withConfig - base).toBe(8);
  });

  test("与 memory picker 对比：config 多 1 行（多 1 内容行）", () => {
    expect(configPickerRows() - memoryPickerRows()).toBe(1);
  });
});
