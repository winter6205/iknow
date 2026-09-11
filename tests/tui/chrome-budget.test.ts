/**
 * tests/tui/chrome-budget.test.ts
 *
 * #321 T5-P0-2：chromeReserveRows + noticeRenderRows 纯函数单测（行账 SSOT）。
 * 这些函数承担 viewportRows 动态预算的逐项入账逻辑，新增底部行必须同步。
 *
 *  - chromeReserveRows：headroom 1 + mode 1 + 输入框(inputRows 动态) + hint +
 *    ContextBar 1 + ask 1 + notice (rows + 1) + modal (rows + 1) + bgLine；
 *    #647 T3 新增 agentStatusRows（agent 现势显示，0-6 行动态，缺省 0 ——
 *    基线用例零影响；专项用例见 agent-status-panel.test.ts）。
 *  - noticeRenderRows：空 / 空字符串 / 多行 / 视觉宽度折行 后行数。
 *  - compactProgressRows（/compact 进度面板，6 行）单独一节：compactRows
 *    缺省 0 —— 基线用例与旧调用方零影响。
 *
 * T8：输入框行账从固定 3 → `inputRows` 动态（默认 1 内容行 + 2 圆角边框行）。
 * inputRows 缺省 = 1 → 3（等价旧固定值）；5 行输入 / 8 行输入（maxLines 上限）
 * 时返回递增预算 —— 视图区高度随之减，不挤掉历史消息。
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
    // chromeReserveRows 行账随 inputVisibleLineCount 严格递增；与
    // textarea height={min(rows, MAX)} 联动 → 高度增长。
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
      expect(expanded - base).toBe(n - 1); // 每增一行预算 +1
    }
  });

  test("T8：到达 MAX_INPUT_LINES 封顶 —— 内部滚动证据（inputRows=7/8/9/20 同预算）", () => {
    // textarea 内部滚动的 SSOT 证据：超过 MAX_INPUT_LINES（8）后行账不再
    // 增长 —— chromeReserveRows 内部 Math.min(..., MAX_INPUT_LINES)。
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
    // 7 → 8 仍递增一行；8 → 9 → 20 封顶同预算（textarea 内部滚动吸收）
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
    // innerCols = 80 - 6 = 74（圆角 2 + paddingX 2 + ❯ 2）
    expect(inputWrapLineCount("x".repeat(100), 80)).toBe(2);
  });

  test("超长 ASCII 文本（300 字符，cols=80）→ ceil(300/74)=5 行", () => {
    expect(inputWrapLineCount("x".repeat(300), 80)).toBe(5);
  });

  test("CJK 按视觉宽度（2 列）折行：50 字 CJK × 2 = 100 视觉列 / 74 = 2 行", () => {
    expect(inputWrapLineCount("测".repeat(50), 80)).toBe(2);
  });

  test("窄终端 cols=20：innerCols=14，长文本 'xxx...' 折多行", () => {
    // 50 字符 ASCII / 14 = 4 行
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
    expect(inputWrapLineCount("a", 5)).toBe(1); // innerCols=1 → 1 行
  });

  test("T9 chrome 联动：长无换行文本 → chromeReserveRows 行账同步增长", () => {
    // 80 字符 ASCII, cols=80 → wrap-aware = 2 行 → chrome inputRows=2 比 1 大 1
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
 * thinkingPickerRows 行账（design-25 thinking-picker，双面板版）。
 *
 * 按面板 kind 分派：thinking 开关面板 5 行（圆角边框 2 行 + 内容 3 行：标题 /
 * 状态行 / 键位提示，**无进度条**）；effort 档位面板 7 行（圆角边框 2 行 + 内容
 * 5 行：标题 / 状态行 / 进度条 / 档位标签 / 键位提示）。**不含 marginBottom=1**
 * —— 与 modalRows 同约定：marginBottom 由 chromeReserveRows 的 +1 入账。
 */
describe("thinkingPickerRows（design-25 面板行账）", () => {
  test("thinking 开关面板（无进度条）：5 行 = 边框 2 + 内容 3", () => {
    expect(thinkingPickerRows("thinking")).toBe(5);
  });

  test("effort 档位面板（含进度条）：7 行 = 边框 2 + 内容 5", () => {
    expect(thinkingPickerRows("effort")).toBe(7);
  });

  test("thinking 面板 +1 marginBottom = 6 行 delta；effort +1 = 8 行 delta", () => {
    // 与 modalRows 的 `+1` 约定一致（面板 marginBottom 由 chromeReserveRows
    // 入账）。
    expect(thinkingPickerRows("thinking") + 1).toBe(6);
    expect(thinkingPickerRows("effort") + 1).toBe(8);
  });

  test("有 picker：pickerRows + 1（marginBottom，与 modalRows 同款 delta）", () => {
    // T3 把 pickerRows 并入 chromeReserveRows 入账：thinking 5 行 + marginBottom
    // 1 = 6 行 delta；effort 7 行 + 1 = 8 行 delta。
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

  // #358 T7：chromeReserveRows 仍接受 panelRows；产品路径恒传 0，
  // 子代理画在输入框下方，不把输入框往上顶。
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

  test("app 产品路径 panelRows 恒 0（子代理不挤输入框）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src/tui/app.tsx"),
      "utf8"
    );
    expect(src).toMatch(/panelRows:\s*0/);
    expect(src).not.toMatch(/panelRows:\s*subagentPanelRows/);
  });

  // #647 T3: agent 现势显示行数入账（与 panelRows 同款：缺省不占行，显式
  // 按值入账；组件无 marginBottom）。专项投影用例见 agent-status-panel.test.ts。
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
 * compactProgressRows 行账（design-25 压缩进度面板）。
 *
 * 6 行 = 边框 2 + 内容 4（标题 / 状态行 / 读条 / 键位提示），**不含
 * marginBottom=1** —— 与 pickerRows / modalRows 同约定，由 chromeReserveRows
 * 的 +1 入账。缺省 0：旧调用方（无压缩面板）行账零影响。
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
