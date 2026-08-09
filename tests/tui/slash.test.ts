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
    ["/compact", "compact"],
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
  it("覆盖全部 9 条词表命令 + Ctrl+C 说明 + Ctrl+Y + 鼠标拖选提示，且无 emoji", () => {
    const joined = helpLines().join("\n");
    for (const cmd of [
      "/sessions",
      "/new",
      "/info",
      "/help",
      "/quit",
      "/exit",
      "/profile",
      "/compact",
    ]) {
      expect(joined).toContain(cmd);
    }
    expect(joined).toContain("Ctrl+C");
    expect(joined).toContain("Ctrl+Y");
    // #238 鼠标拖选提示（拖选 → 释放自动复制）。
    expect(joined).toContain("鼠标拖选");
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
      "compact",
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
    "compact",
  ] as const;

  it("cursor=0 → /sessions （首条）", () => {
    expect(slashCompleteFromList(ALL, 0)).toBe("/sessions ");
  });

  it("cursor=2 → /quit （按词表顺序第 3 条）", () => {
    expect(slashCompleteFromList(ALL, 2)).toBe("/quit ");
  });

  it("cursor=8 → /compact （末条）", () => {
    expect(slashCompleteFromList(ALL, 8)).toBe("/compact ");
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
 * #238 鼠标拖选复制 — 移除 /copy 命令（#237 取消）。
 * 词表 8 条；Ctrl+Y 改为"复制当前鼠标选区"（无选区时提示先拖选）。
 * helpLines 增加鼠标拖选说明。
 */
describe("#238 鼠标拖选：词表移除 /copy", () => {
  it("/copy → unknown（不在词表）", () => {
    expect(parseTuiInput("/copy")).toEqual({ kind: "unknown", raw: "/copy" });
  });

  it('"/com" 前缀 → ["compact"]（/copy 移除后唯一候选）', () => {
    expect(slashSuggestions("/com")).toEqual(["compact"]);
  });

  it("/help 增加鼠标拖选提示，且无 /copy", () => {
    const joined = helpLines().join("\n");
    expect(joined).not.toContain("/copy");
    expect(joined).toContain("鼠标拖选");
    expect(joined).toContain("Ctrl+Y");
  });
});

/** /compact — 手动压缩当前会话上下文（保留尾部，裁剪早期消息）。 */
describe("/compact 词表", () => {
  it("/compact → command compact", () => {
    expect(parseTuiInput("/compact")).toEqual({
      kind: "command",
      command: "compact",
    });
  });

  it("大小写与空白容忍", () => {
    expect(parseTuiInput("  /COMPACT  ")).toEqual({
      kind: "command",
      command: "compact",
    });
  });

  it('"/com" 前缀 → ["compact"]', () => {
    expect(slashSuggestions("/com")).toEqual(["compact"]);
  });

  it('/compact 唯一匹配 → 补全 "/compact "', () => {
    expect(slashComplete("/comp")).toBe("/compact ");
  });

  it("hint 描述：压缩上下文", () => {
    expect(slashHintLines(["compact"])).toEqual([
      { command: "compact", description: "压缩上下文" },
    ]);
  });

  it("/help 覆盖 /compact 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/compact");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});
