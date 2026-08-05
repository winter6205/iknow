/**
 * tests/tui/slash.test.ts
 *
 * #146 slash 词表解析（SC 12：TUI 自建词表，不复用 chat processChatLine）：
 * 6 命令 + 未知 /xxx + 普通消息 + 空输入 + /reset 天然不可达。
 */
import { describe, expect, it } from "vitest";
import {
  helpLines,
  parseTuiInput,
  slashComplete,
  slashHintLines,
  slashSuggestions,
} from "../../src/tui/slash.js";

describe("parseTuiInput: 词表命中", () => {
  it.each([
    ["/sessions", "sessions"],
    ["/new", "new"],
    ["/quit", "quit"],
    ["/exit", "exit"],
    ["/help", "help"],
    ["/info", "info"],
  ] as const)("解析 %s → command %s", (input, command) => {
    const parsed = parseTuiInput(input);
    expect(parsed).toEqual({ kind: "command", command });
  });

  it("大小写与前后空白容忍", () => {
    expect(parseTuiInput("  /QUIT  ")).toEqual({
      kind: "command",
      command: "quit",
    });
  });

  it("命令后带参数仍命中命令（词表命令无参数语义）", () => {
    expect(parseTuiInput("/new now")).toEqual({
      kind: "command",
      command: "new",
    });
  });
});

describe("parseTuiInput: 未知命令", () => {
  it("未命中词表 → unknown（携带原文供 UI 提示）", () => {
    expect(parseTuiInput("/foobar")).toEqual({
      kind: "unknown",
      raw: "/foobar",
    });
  });

  it("/reset 不在词表内即天然不可达（Q5c 废除）", () => {
    expect(parseTuiInput("/reset")).toEqual({ kind: "unknown", raw: "/reset" });
  });
});

describe("parseTuiInput: 普通消息与边界", () => {
  it("不以 / 开头 → message（trim 后文本）", () => {
    expect(parseTuiInput("  你好  ")).toEqual({
      kind: "message",
      text: "你好",
    });
  });

  it("消息内嵌 / 不触发词表", () => {
    expect(parseTuiInput("a/b")).toEqual({ kind: "message", text: "a/b" });
  });

  it("空/纯空白 → message 空文本（调用方按空输入忽略）", () => {
    expect(parseTuiInput("")).toEqual({ kind: "message", text: "" });
    expect(parseTuiInput("   ")).toEqual({ kind: "message", text: "" });
  });
});

describe("helpLines", () => {
  it("覆盖全部 6 条词表命令 + Ctrl+C 说明，且无 emoji", () => {
    const joined = helpLines().join("\n");
    for (const cmd of [
      "/sessions",
      "/new",
      "/info",
      "/help",
      "/quit",
      "/exit",
    ]) {
      expect(joined).toContain(cmd);
    }
    expect(joined).toContain("Ctrl+C");
    // 无 emoji（词表层面自检）：不含常见 emoji 码区字符
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

describe("slashSuggestions: 前缀过滤 + 词表顺序", () => {
  it("空字符串 → 空数组", () => {
    expect(slashSuggestions("")).toEqual([]);
  });

  it('"/" → 全部 6 条（按词表插入顺序）', () => {
    expect(slashSuggestions("/")).toEqual([
      "sessions",
      "new",
      "quit",
      "exit",
      "help",
      "info",
    ]);
  });

  it('"/q" → ["quit"]', () => {
    expect(slashSuggestions("/q")).toEqual(["quit"]);
  });

  it('"/e" → ["exit"]', () => {
    expect(slashSuggestions("/e")).toEqual(["exit"]);
  });

  it('"/xxx" → 空数组（无匹配）', () => {
    expect(slashSuggestions("/xxx")).toEqual([]);
  });

  it('不以 "/" 开头 → 空数组（hello）', () => {
    expect(slashSuggestions("hello")).toEqual([]);
  });

  it('trim 后仍以 "/" 开头 → 正常过滤', () => {
    expect(slashSuggestions("  /q  ")).toEqual(["quit"]);
  });
});

describe('slashComplete: 唯一匹配 → "/cmd "；0/多匹配 → null', () => {
  it('"/q" → "/quit "（唯一匹配 + 尾随空格 + 小写）', () => {
    expect(slashComplete("/q")).toBe("/quit ");
  });

  it('"/" → null（6 匹配）', () => {
    expect(slashComplete("/")).toBeNull();
  });

  it('"/xxx" → null（0 匹配）', () => {
    expect(slashComplete("/xxx")).toBeNull();
  });
});

describe("slashHintLines: 一行短描述", () => {
  it('传入 ["sessions", "quit"] → 形状 + 内容', () => {
    expect(slashHintLines(["sessions", "quit"])).toEqual([
      { command: "sessions", description: "打开会话列表" },
      { command: "quit", description: "退出（别名 /exit）" },
    ]);
  });

  it("空数组 → 空数组", () => {
    expect(slashHintLines([])).toEqual([]);
  });
});
