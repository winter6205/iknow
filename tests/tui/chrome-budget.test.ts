/**
 * tests/tui/chrome-budget.test.ts
 *
 * #321 T5-P0-2：chromeReserveRows + noticeRenderRows 纯函数单测（行账 SSOT）。
 * 这些函数承担 viewportRows 动态预算的逐项入账逻辑，新增底部行必须同步。
 *
 *  - chromeReserveRows：headroom 1 + mode 1 + 输入框 3 + hint + ContextBar 1
 *    + ask 1 + notice (rows + 1) + modal (rows + 1) + bgLine；
 *  - noticeRenderRows：空 / 空字符串 / 多行 / 视觉宽度折行 后行数。
 */
import { describe, expect, test } from "bun:test";
import {
  bgStatusLine,
  chromeReserveRows,
  noticeRenderRows,
} from "../../src/tui/app.js";
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
    });
    expect(rows).toBe(1 + 1 + 3 + 0 + 1 + 1);
  });

  test("有 bg：+1 行", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const withBg = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: true,
    });
    expect(withBg - base).toBe(1);
  });

  test("有 hint：hintRows 计入", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const withHint = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 3,
      bgLine: false,
    });
    expect(withHint - base).toBe(3);
  });

  test("有 notice：noticeRows + 1（marginBottom）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const withNotice = chromeReserveRows({
      noticeRows: 2,
      inputHintRows: 0,
      bgLine: false,
    });
    expect(withNotice - base).toBe(3);
  });

  test("有 modal：modalRows + 1（marginBottom）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const withModal = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      modalRows: 5,
    });
    expect(withModal - base).toBe(6);
  });

  test("全部叠加：bg + hint + notice + modal 一并入账", () => {
    const rows = chromeReserveRows({
      noticeRows: 2,
      inputHintRows: 3,
      bgLine: true,
      modalRows: 5,
    });
    expect(rows).toBe(1 + 1 + 3 + 3 + 1 + 1 + 3 + 6 + 1);
  });

  test("modalRows 缺省（undefined）= 0，行为同未传", () => {
    const a = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
    });
    const b = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      modalRows: undefined,
    });
    expect(a).toBe(b);
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
