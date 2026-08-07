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
  slashCompleteFromList,
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
    ["/thinking", "thinking"],
    ["/profile", "profile"],
    ["/copy", "copy"],
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
  it("覆盖全部 9 条词表命令 + Ctrl+C 说明 + Ctrl+Y，且无 emoji", () => {
    const joined = helpLines().join("\n");
    for (const cmd of [
      "/sessions",
      "/new",
      "/info",
      "/help",
      "/quit",
      "/exit",
      "/profile",
      "/copy",
    ]) {
      expect(joined).toContain(cmd);
    }
    expect(joined).toContain("Ctrl+C");
    expect(joined).toContain("Ctrl+Y");
    // 无 emoji（词表层面自检）：不含常见 emoji 码区字符
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

describe("slashSuggestions: 前缀过滤 + 词表顺序", () => {
  it("空字符串 → 空数组", () => {
    expect(slashSuggestions("")).toEqual([]);
  });

  it('"/" → 全部 9 条（按词表插入顺序）', () => {
    expect(slashSuggestions("/")).toEqual([
      "sessions",
      "new",
      "quit",
      "exit",
      "help",
      "info",
      "thinking",
      "profile",
      "copy",
    ]);
  });

  it('"/q" → ["quit"]', () => {
    expect(slashSuggestions("/q")).toEqual(["quit"]);
  });

  it('"/e" → ["exit"]', () => {
    expect(slashSuggestions("/e")).toEqual(["exit"]);
  });

  it('"/c" → ["copy"]', () => {
    expect(slashSuggestions("/c")).toEqual(["copy"]);
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

  it('"/" → null（9 匹配）', () => {
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

describe("slashCompleteFromList: 按 cursor 补全（任务 B）", () => {
  const ALL = [
    "sessions",
    "new",
    "quit",
    "exit",
    "help",
    "info",
    "thinking",
    "profile",
    "copy",
  ] as const;

  it("cursor=0 → /sessions （首条）", () => {
    expect(slashCompleteFromList(ALL, 0)).toBe("/sessions ");
  });

  it("cursor=2 → /quit （按词表顺序第 3 条）", () => {
    expect(slashCompleteFromList(ALL, 2)).toBe("/quit ");
  });

  it("cursor=8 → /copy （末条）", () => {
    expect(slashCompleteFromList(ALL, 8)).toBe("/copy ");
  });

  it("cursor 越界上 / 下 / 空列表 → null", () => {
    expect(slashCompleteFromList(ALL, -1)).toBeNull();
    expect(slashCompleteFromList(ALL, ALL.length)).toBeNull();
    expect(slashCompleteFromList(ALL, 999)).toBeNull();
    expect(slashCompleteFromList([], 0)).toBeNull();
  });

  it("单元素列表 + cursor=0 → 该元素", () => {
    expect(slashCompleteFromList(["quit"], 0)).toBe("/quit ");
  });
});

/**
 * T6 (D5):/thinking — 切换当前会话 thinking 折叠面板展开态。
 * 词表新增第 7 条;与 IKNOW_CHAT_SHOW_THINKING 对齐(chat 端折叠摘要)。
 */
describe("T6 /thinking 词表", () => {
  it("/thinking → command thinking", () => {
    expect(parseTuiInput("/thinking")).toEqual({
      kind: "command",
      command: "thinking",
    });
  });

  it("大小写与空白容忍", () => {
    expect(parseTuiInput("  /THINKING  ")).toEqual({
      kind: "command",
      command: "thinking",
    });
  });

  it('"/" 全部候选含 thinking（第 7 条）', () => {
    expect(slashSuggestions("/")).toContain("thinking");
  });

  it('"/think" 前缀 → ["thinking"]', () => {
    expect(slashSuggestions("/think")).toEqual(["thinking"]);
  });

  it('/thinking 唯一匹配 → 补全 "/thinking "', () => {
    expect(slashComplete("/think")).toBe("/thinking ");
  });

  it("/help 覆盖 /thinking 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/thinking");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

/**
 * #237 /copy — 复制最近一轮 assistant 全文到系统剪贴板（显示式复制，
 * DECSET 1000h 启用下鼠标拖选不可用，故提供命令式入口）。
 * 词表新增第 9 条;UI 接线由 application code（app.tsx copyLastAssistant
 * + handleSubmit case "copy" + useInput Ctrl+Y）执行，词表解析只管
 * /copy → command: "copy"。
 */
describe("#237 /copy 词表", () => {
  it("/copy → command copy", () => {
    expect(parseTuiInput("/copy")).toEqual({
      kind: "command",
      command: "copy",
    });
  });

  it("大小写与空白容忍", () => {
    expect(parseTuiInput("  /COPY  ")).toEqual({
      kind: "command",
      command: "copy",
    });
  });

  it('"/" 全部候选含 copy（末条）', () => {
    expect(slashSuggestions("/")).toContain("copy");
  });

  it('"/co" 前缀 → ["copy"]', () => {
    expect(slashSuggestions("/co")).toEqual(["copy"]);
  });

  it('/copy 唯一匹配 → 补全 "/copy "', () => {
    expect(slashComplete("/co")).toBe("/copy ");
  });

  it("/help 覆盖 /copy + Ctrl+Y 说明，且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/copy");
    expect(joined).toContain("Ctrl+Y");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});
