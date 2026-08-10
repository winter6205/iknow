/**
 * tests/tui/slash.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/slash.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
 *
 * #146 slash 词表解析（SC 12：TUI 自建词表，不复用 chat processChatLine）：
 * 9 命令 + 未知 /xxx + 普通消息 + 空输入 + /reset 天然不可达。
 */
import { describe, expect, test } from "bun:test";
import {
  helpLines,
  parseTuiInput,
  slashComplete,
  slashCompleteFromList,
  slashHintLines,
  slashSuggestions,
} from "../../src/tui/slash.js";

describe("parseTuiInput: 词表命中", () => {
  for (const [input, command] of [
    ["/sessions", "sessions"],
    ["/new", "new"],
    ["/quit", "quit"],
    ["/exit", "exit"],
    ["/help", "help"],
    ["/info", "info"],
    ["/thinking", "thinking"],
    ["/profile", "profile"],
    ["/compact", "compact"],
  ] as const) {
    test(`解析 ${input} → command ${command}`, () => {
      const parsed = parseTuiInput(input);
      expect(parsed).toEqual({ kind: "command", command });
    });
  }

  test("大小写与前后空白容忍", () => {
    expect(parseTuiInput("  /QUIT  ")).toEqual({
      kind: "command",
      command: "quit",
    });
  });

  test("命令后带参数仍命中命令（词表命令无参数语义）", () => {
    expect(parseTuiInput("/new now")).toEqual({
      kind: "command",
      command: "new",
    });
  });
});

describe("parseTuiInput: 未知命令", () => {
  test("未命中词表 → unknown（携带原文供 UI 提示）", () => {
    expect(parseTuiInput("/foobar")).toEqual({
      kind: "unknown",
      raw: "/foobar",
    });
  });

  test("/reset 不在词表内即天然不可达（Q5c 废除）", () => {
    expect(parseTuiInput("/reset")).toEqual({ kind: "unknown", raw: "/reset" });
  });
});

describe("parseTuiInput: 普通消息与边界", () => {
  test("不以 / 开头 → message（trim 后文本）", () => {
    expect(parseTuiInput("  你好  ")).toEqual({
      kind: "message",
      text: "你好",
    });
  });

  test("消息内嵌 / 不触发词表", () => {
    expect(parseTuiInput("a/b")).toEqual({ kind: "message", text: "a/b" });
  });

  test("空/纯空白 → message 空文本（调用方按空输入忽略）", () => {
    expect(parseTuiInput("")).toEqual({ kind: "message", text: "" });
    expect(parseTuiInput("   ")).toEqual({ kind: "message", text: "" });
  });
});

describe("helpLines", () => {
  test("覆盖全部 9 条词表命令 + Ctrl+C 说明 + 鼠标拖选提示，且无 emoji；Ctrl+Y 已移除", () => {
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
    // #321 B1 fix-session：Ctrl+Y 已移除（拖选仅高亮，右键才复制）。
    expect(joined).not.toContain("Ctrl+Y");
    // #321 B1 鼠标拖选提示（拖选高亮 → 右键复制到剪贴板）。
    expect(joined).toContain("鼠标拖选");
    expect(joined).toContain("右键复制到剪贴板");
    // 无 emoji（词表层面自检）：不含常见 emoji 码区字符
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

describe("slashSuggestions: 前缀过滤 + 词表顺序", () => {
  test("空字符串 → 空数组", () => {
    expect(slashSuggestions("")).toEqual([]);
  });

  test('"/" → 全部 9 条（按词表插入顺序）', () => {
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

  test('"/q" → ["quit"]', () => {
    expect(slashSuggestions("/q")).toEqual(["quit"]);
  });

  test('"/e" → ["exit"]', () => {
    expect(slashSuggestions("/e")).toEqual(["exit"]);
  });

  test('"/xxx" → 空数组（无匹配）', () => {
    expect(slashSuggestions("/xxx")).toEqual([]);
  });

  test('不以 "/" 开头 → 空数组（hello）', () => {
    expect(slashSuggestions("hello")).toEqual([]);
  });

  test('trim 后仍以 "/" 开头 → 正常过滤', () => {
    expect(slashSuggestions("  /q  ")).toEqual(["quit"]);
  });
});

describe('slashComplete: 唯一匹配 → "/cmd "；0/多匹配 → null', () => {
  test('"/q" → "/quit "（唯一匹配 + 尾随空格 + 小写）', () => {
    expect(slashComplete("/q")).toBe("/quit ");
  });

  test('"/" → null（9 匹配）', () => {
    expect(slashComplete("/")).toBeNull();
  });

  test('"/xxx" → null（0 匹配）', () => {
    expect(slashComplete("/xxx")).toBeNull();
  });
});

describe("slashHintLines: 一行短描述", () => {
  test('传入 ["sessions", "quit"] → 形状 + 内容', () => {
    expect(slashHintLines(["sessions", "quit"])).toEqual([
      { command: "sessions", description: "打开会话列表" },
      { command: "quit", description: "退出（别名 /exit）" },
    ]);
  });

  test("空数组 → 空数组", () => {
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

  test("cursor=0 → /sessions （首条）", () => {
    expect(slashCompleteFromList(ALL, 0)).toBe("/sessions ");
  });

  test("cursor=2 → /quit （按词表顺序第 3 条）", () => {
    expect(slashCompleteFromList(ALL, 2)).toBe("/quit ");
  });

  test("cursor=8 → /compact （末条）", () => {
    expect(slashCompleteFromList(ALL, 8)).toBe("/compact ");
  });

  test("cursor 越界上 / 下 / 空列表 → null", () => {
    expect(slashCompleteFromList(ALL, -1)).toBeNull();
    expect(slashCompleteFromList(ALL, ALL.length)).toBeNull();
    expect(slashCompleteFromList(ALL, 999)).toBeNull();
    expect(slashCompleteFromList([], 0)).toBeNull();
  });

  test("单元素列表 + cursor=0 → 该元素", () => {
    expect(slashCompleteFromList(["quit"], 0)).toBe("/quit ");
  });
});

/**
 * T6 (D5):/thinking — 切换当前会话 thinking 折叠面板展开态。
 * 词表新增第 7 条;与 IKNOW_CHAT_SHOW_THINKING 对齐(chat 端折叠摘要)。
 */
describe("T6 /thinking 词表", () => {
  test("/thinking → command thinking", () => {
    expect(parseTuiInput("/thinking")).toEqual({
      kind: "command",
      command: "thinking",
    });
  });

  test("大小写与空白容忍", () => {
    expect(parseTuiInput("  /THINKING  ")).toEqual({
      kind: "command",
      command: "thinking",
    });
  });

  test('"/" 全部候选含 thinking（第 7 条）', () => {
    expect(slashSuggestions("/")).toContain("thinking");
  });

  test('"/think" 前缀 → ["thinking"]', () => {
    expect(slashSuggestions("/think")).toEqual(["thinking"]);
  });

  test('/thinking 唯一匹配 → 补全 "/thinking "', () => {
    expect(slashComplete("/think")).toBe("/thinking ");
  });

  test("/help 覆盖 /thinking 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/thinking");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

/**
 * #321 B1 fix-session 右键复制 — 移除 /copy 命令（#237 取消）；
 * 拖选仅高亮，右键才复制到剪贴板；Ctrl+Y 复制已移除。
 * helpLines 只保留鼠标拖选 + 右键复制说明。
 */
describe("#321 B1 右键复制：词表移除 /copy + Ctrl+Y", () => {
  test("/copy → unknown（不在词表）", () => {
    expect(parseTuiInput("/copy")).toEqual({ kind: "unknown", raw: "/copy" });
  });

  test('"/com" 前缀 → ["compact"]（/copy 移除后唯一候选）', () => {
    expect(slashSuggestions("/com")).toEqual(["compact"]);
  });

  test("/help 只保留鼠标拖选 + 右键复制说明，无 /copy、无 Ctrl+Y", () => {
    const joined = helpLines().join("\n");
    expect(joined).not.toContain("/copy");
    expect(joined).not.toContain("Ctrl+Y");
    expect(joined).toContain("鼠标拖选");
    expect(joined).toContain("右键复制到剪贴板");
  });
});

/** /compact — 手动压缩当前会话上下文（保留尾部，裁剪早期消息）。 */
describe("/compact 词表", () => {
  test("/compact → command compact", () => {
    expect(parseTuiInput("/compact")).toEqual({
      kind: "command",
      command: "compact",
    });
  });

  test("大小写与空白容忍", () => {
    expect(parseTuiInput("  /COMPACT  ")).toEqual({
      kind: "command",
      command: "compact",
    });
  });

  test('"/com" 前缀 → ["compact"]', () => {
    expect(slashSuggestions("/com")).toEqual(["compact"]);
  });

  test('/compact 唯一匹配 → 补全 "/compact "', () => {
    expect(slashComplete("/comp")).toBe("/compact ");
  });

  test("hint 描述：压缩上下文", () => {
    expect(slashHintLines(["compact"])).toEqual([
      { command: "compact", description: "压缩上下文" },
    ]);
  });

  test("/help 覆盖 /compact 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/compact");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});
