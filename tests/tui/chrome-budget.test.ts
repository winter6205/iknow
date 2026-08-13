/**
 * tests/tui/chrome-budget.test.ts
 *
 * #321 T5-P0-2：chromeReserveRows + noticeRenderRows 纯函数单测（行账 SSOT）。
 * 这些函数承担 viewportRows 动态预算的逐项入账逻辑，新增底部行必须同步。
 *
 *  - chromeReserveRows：headroom 1 + mode 1 + 输入框(inputRows 动态) + hint +
 *    ContextBar 1 + ask 1 + notice (rows + 1) + modal (rows + 1) + bgLine；
 *  - noticeRenderRows：空 / 空字符串 / 多行 / 视觉宽度折行 后行数。
 *
 * T8：输入框行账从固定 3 → `inputRows` 动态（默认 1 内容行 + 2 圆角边框行）。
 * inputRows 缺省 = 1 → 3（等价旧固定值）；5 行输入 / 8 行输入（maxLines 上限）
 * 时返回递增预算 —— 视图区高度随之减，不挤掉历史消息。
 */
import { describe, expect, test } from "bun:test";
import {
  bgStatusLine,
  chromeReserveRows,
  inputVisibleLineCount,
  noticeRenderRows,
} from "../../src/tui/app.js";
import { thinkingPickerRows } from "../../src/tui/thinking-picker.js";
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
});
