/**
 * tests/tui/slash.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/slash.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
 *
 * #146 slash 词表解析（SC 12：TUI 自建词表，不复用 chat processChatLine）：
 * 11 命令 + 未知 /xxx + 普通消息 + 空输入 + /reset 天然不可达。
 */
import { describe, expect, test } from "bun:test";
import {
  effortHasArg,
  helpLines,
  parseEffortLevel,
  parseSkillLoad,
  parseTuiInput,
  slashComplete,
  slashCompleteFromCandidates,
  slashCompleteFromList,
  slashHintLines,
  slashSuggestions,
  type SlashCandidate,
} from "../../src/tui/slash.js";

describe("parseTuiInput: 词表命中", () => {
  for (const [input, command] of [
    ["/sessions", "sessions"],
    ["/new", "new"],
    ["/mcp", "mcp"],
    ["/quit", "quit"],
    ["/exit", "exit"],
    ["/help", "help"],
    ["/info", "info"],
    ["/thinking", "thinking"],
    ["/compact", "compact"],
    ["/rewind", "rewind"],
  ] as const) {
    test(`解析 ${input} → command ${command}`, () => {
      const parsed = parseTuiInput(input);
      expect(parsed).toEqual({ kind: "command", command });
    });
  }

  test("解析 /effort → command effort（arg 由 parseEffortLevel 单独解析）", () => {
    expect(parseTuiInput("/effort")).toEqual({
      kind: "command",
      command: "effort",
    });
  });

  test("命令后带参数仍命中命令（/effort high → command effort）", () => {
    expect(parseTuiInput("/effort high")).toEqual({
      kind: "command",
      command: "effort",
    });
  });

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
  test("覆盖全部 11 条词表命令 + Ctrl+C 说明 + 鼠标拖选提示，且无 emoji；Ctrl+Y 已移除", () => {
    const joined = helpLines().join("\n");
    for (const cmd of [
      "/sessions",
      "/new",
      "/mcp",
      "/info",
      "/help",
      "/thinking",
      "/effort",
      "/quit",
      "/exit",
      "/compact",
      "/rewind",
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

describe("slashSuggestions: 前缀过滤 + 词表顺序（#337 Phase C → SlashCandidate 判别联合）", () => {
  test("空字符串 → 空数组", () => {
    expect(slashSuggestions("")).toEqual([]);
  });

  test('"/" → 全部 11 条静态命令（按词表插入顺序，kind="command"；rewind + mcp，无 /profile）', () => {
    expect(slashSuggestions("/")).toEqual([
      { kind: "command", command: "sessions" },
      { kind: "command", command: "new" },
      { kind: "command", command: "quit" },
      { kind: "command", command: "exit" },
      { kind: "command", command: "help" },
      { kind: "command", command: "info" },
      { kind: "command", command: "thinking" },
      { kind: "command", command: "effort" },
      { kind: "command", command: "compact" },
      { kind: "command", command: "rewind" },
      { kind: "command", command: "mcp" },
    ]);
  });

  test('"/q" → [{command: quit}]', () => {
    expect(slashSuggestions("/q")).toEqual([
      { kind: "command", command: "quit" },
    ]);
  });

  test('"/e" → [{command: exit}, {command: effort}]（/effort 加入后共享前缀）', () => {
    expect(slashSuggestions("/e")).toEqual([
      { kind: "command", command: "exit" },
      { kind: "command", command: "effort" },
    ]);
  });

  test('"/xxx" → 空数组（无匹配）', () => {
    expect(slashSuggestions("/xxx")).toEqual([]);
  });

  test('不以 "/" 开头 → 空数组（hello）', () => {
    expect(slashSuggestions("hello")).toEqual([]);
  });

  test('trim 后仍以 "/" 开头 → 正常过滤', () => {
    expect(slashSuggestions("  /q  ")).toEqual([
      { kind: "command", command: "quit" },
    ]);
  });

  test("不传 skills（缺省）→ 行为与旧版一致（纯静态命令）", () => {
    expect(slashSuggestions("/q")).toEqual([
      { kind: "command", command: "quit" },
    ]);
  });

  test('"/" 且传 skills → 仅静态命令（#377 E：空前缀不展开 skill，避免 popup 过载）', () => {
    expect(
      slashSuggestions("/", [
        { name: "echo", description: "回声" },
        { name: "code-review", description: "代码审查" },
      ])
    ).toEqual([
      { kind: "command", command: "sessions" },
      { kind: "command", command: "new" },
      { kind: "command", command: "quit" },
      { kind: "command", command: "exit" },
      { kind: "command", command: "help" },
      { kind: "command", command: "info" },
      { kind: "command", command: "thinking" },
      { kind: "command", command: "effort" },
      { kind: "command", command: "compact" },
      { kind: "command", command: "rewind" },
      { kind: "command", command: "mcp" },
    ]);
  });

  test('"/" + 1 字符前缀（如 /c）→ skill 才入场（#377 E）', () => {
    expect(
      slashSuggestions("/c", [
        { name: "echo", description: "回声" },
        { name: "code-review", description: "代码审查" },
      ])
    ).toContainEqual({
      kind: "skill",
      name: "code-review",
      description: "代码审查",
    });
    expect(
      slashSuggestions("/c", [
        { name: "echo", description: "回声" },
        { name: "code-review", description: "代码审查" },
      ])
    ).not.toContainEqual({ kind: "skill", name: "echo", description: "回声" });
  });

  test("skill 名前缀过滤大小写不敏感（/CO 同时命中静态 compact + 两个 skill）", () => {
    expect(
      slashSuggestions("/CO", [
        { name: "compact-wizard", description: "压缩向导" },
        { name: "code-review", description: "代码审查" },
      ])
    ).toEqual([
      { kind: "command", command: "compact" },
      { kind: "skill", name: "compact-wizard", description: "压缩向导" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("skill 无 description → description 缺省（undefined）", () => {
    expect(slashSuggestions("/ba", [{ name: "bash-doc" }])).toEqual([
      { kind: "skill", name: "bash-doc", description: undefined },
    ]);
  });

  test('"/c" 混合：静态命令（compact）在前 + skill（code-review）在后', () => {
    expect(
      slashSuggestions("/c", [{ name: "code-review", description: "代码审查" }])
    ).toEqual([
      { kind: "command", command: "compact" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("无前缀命中的 skill 不出现", () => {
    expect(
      slashSuggestions("/echo", [
        { name: "echo", description: "回声" },
        { name: "zzz", description: "不匹配" },
      ])
    ).toEqual([{ kind: "skill", name: "echo", description: "回声" }]);
  });
});

describe('slashComplete: 唯一匹配 → "/cmd "；0/多匹配 → null', () => {
  test('"/q" → "/quit "（唯一匹配 + 尾随空格 + 小写）', () => {
    expect(slashComplete("/q")).toBe("/quit ");
  });

  test('"/" → null（10 匹配）', () => {
    expect(slashComplete("/")).toBeNull();
  });

  test('"/xxx" → null（0 匹配）', () => {
    expect(slashComplete("/xxx")).toBeNull();
  });

  test('"/ec" + skills → "/echo "（skill 唯一匹配，尾随空格）', () => {
    expect(slashComplete("/ec", [{ name: "echo", description: "回声" }])).toBe(
      "/echo "
    );
  });

  test('"/ec" + skills（skill 名含连字符）→ "/code-review "（原样保留）', () => {
    expect(
      slashComplete("/code-rev", [
        { name: "code-review", description: "代码审查" },
      ])
    ).toBe("/code-review ");
  });

  test("跨静态 + skill 冲突多匹配 → null（'/e' 同时命中 exit + echo）", () => {
    expect(
      slashComplete("/e", [{ name: "echo", description: "回声" }])
    ).toBeNull();
  });

  test("skill 名与静态命令前缀重合：静态优先（'/' 命中 11 静态 + skill → null）", () => {
    expect(
      slashComplete("/", [{ name: "sessions-helper", description: "会话助手" }])
    ).toBeNull();
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
    "effort",
    "compact",
    "rewind",
    "mcp",
  ] as const;

  test("cursor=0 → /sessions （首条）", () => {
    expect(slashCompleteFromList(ALL, 0)).toBe("/sessions ");
  });

  test("cursor=2 → /quit （按词表顺序第 3 条）", () => {
    expect(slashCompleteFromList(ALL, 2)).toBe("/quit ");
  });

  test("cursor=7 → /effort （词表第 8 条）", () => {
    expect(slashCompleteFromList(ALL, 7)).toBe("/effort ");
  });

  test("cursor=8 → /compact （词表第 9 条）", () => {
    expect(slashCompleteFromList(ALL, 8)).toBe("/compact ");
  });

  test("cursor=9 → /rewind （词表第 10 条）", () => {
    expect(slashCompleteFromList(ALL, 9)).toBe("/rewind ");
  });

  test("cursor=10 → /mcp （词表末条，append-only）", () => {
    expect(slashCompleteFromList(ALL, 10)).toBe("/mcp ");
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
    const all = slashSuggestions("/");
    expect(all).toContainEqual({ kind: "command", command: "thinking" });
  });

  test('"/think" 前缀 → [{command: thinking}]', () => {
    expect(slashSuggestions("/think")).toEqual([
      { kind: "command", command: "thinking" },
    ]);
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

  test('"/com" 前缀 → [{command: compact}]（/copy 移除后唯一候选）', () => {
    expect(slashSuggestions("/com")).toEqual([
      { kind: "command", command: "compact" },
    ]);
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

  test('"/com" 前缀 → [{command: compact}]', () => {
    expect(slashSuggestions("/com")).toEqual([
      { kind: "command", command: "compact" },
    ]);
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

/**
 * #337 Phase C：/skill-name [提示词] 解析 —— 精确命中 skill 名 → {name,
 * remainder}；命中静态命令 / 不匹配 → undefined（静态命令优先）。
 */
describe("parseSkillLoad: /skill-name [提示词] 解析", () => {
  const SKILLS = [
    { name: "echo", description: "回声" },
    { name: "code-review", description: "代码审查" },
  ];

  test('"/echo" 精确命中 → { name: "echo", remainder: "" }', () => {
    expect(parseSkillLoad("/echo", SKILLS)).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  test('"/echo 帮我做 X" → remainder 为剩余部分', () => {
    expect(parseSkillLoad("/echo 帮我做 X", SKILLS)).toEqual({
      name: "echo",
      remainder: "帮我做 X",
    });
  });

  test("remainder 保留多空格与连字符内容（trim 后）", () => {
    expect(parseSkillLoad("/code-review   审查   diff", SKILLS)).toEqual({
      name: "code-review",
      remainder: "审查   diff",
    });
  });

  test("skill 名大小写不敏感命中（/ECHO → echo）", () => {
    expect(parseSkillLoad("  /ECHO   ", SKILLS)).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  test("声明大小写保留（skill 名 Echo，输入 /echo → name 保留 Echo）", () => {
    expect(
      parseSkillLoad("/echo 你好", [{ name: "Echo", description: "回声" }])
    ).toEqual({ name: "Echo", remainder: "你好" });
  });

  test("命中静态命令 → undefined（/compact 不抢 skill-load）", () => {
    expect(parseSkillLoad("/compact", SKILLS)).toBeUndefined();
    expect(parseSkillLoad("/quit 现在", SKILLS)).toBeUndefined();
  });

  test("不匹配（无此 skill）→ undefined", () => {
    expect(parseSkillLoad("/foobar", SKILLS)).toBeUndefined();
  });

  test("skill 名前缀不完整命中 → undefined（须精确命中）", () => {
    expect(parseSkillLoad("/ec", SKILLS)).toBeUndefined();
  });

  test("非 / 开头（普通消息）→ undefined", () => {
    expect(parseSkillLoad("hello", SKILLS)).toBeUndefined();
  });

  test("空 / 纯空白 → undefined", () => {
    expect(parseSkillLoad("", SKILLS)).toBeUndefined();
    expect(parseSkillLoad("   ", SKILLS)).toBeUndefined();
  });

  test("空 skills 数组 → undefined", () => {
    expect(parseSkillLoad("/echo", [])).toBeUndefined();
  });
});

/** #337 Phase C：SlashCandidate 版按 cursor 补全（静态命令 | skill 通用）。 */
describe("slashCompleteFromCandidates: 按 cursor 补全 SlashCandidate", () => {
  const MIXED: ReadonlyArray<SlashCandidate> = [
    { kind: "command", command: "sessions" },
    { kind: "skill", name: "echo" },
  ];

  test("cursor=0（静态命令）→ /sessions ", () => {
    expect(slashCompleteFromCandidates(MIXED, 0)).toBe("/sessions ");
  });

  test("cursor=1（skill）→ /echo ", () => {
    expect(slashCompleteFromCandidates(MIXED, 1)).toBe("/echo ");
  });

  test("cursor 越界上 / 下 / 空列表 → null", () => {
    expect(slashCompleteFromCandidates(MIXED, -1)).toBeNull();
    expect(slashCompleteFromCandidates(MIXED, 2)).toBeNull();
    expect(slashCompleteFromCandidates([], 0)).toBeNull();
  });
});

/**
 * #361 Phase D：/mcp 词表收口（append-only 末位，词表 9 → 10）。
 * 静态命令，与 parseSkillLoad 正交（命中静态词表返回 undefined，不抢
 * skill-load）；hint 描述 + helpLines 真描述。
 */
describe("#361 Phase D /mcp 词表", () => {
  test("/mcp → command mcp", () => {
    expect(parseTuiInput("/mcp")).toEqual({ kind: "command", command: "mcp" });
  });

  test("大小写与空白容忍（/MCP、 /Mcp ）", () => {
    expect(parseTuiInput("  /MCP  ")).toEqual({
      kind: "command",
      command: "mcp",
    });
    expect(parseTuiInput("/Mcp")).toEqual({
      kind: "command",
      command: "mcp",
    });
  });

  test('"/m" 前缀 → 唯一候选 mcp（不与任何旧命令前缀冲突）', () => {
    expect(slashSuggestions("/m")).toEqual([
      { kind: "command", command: "mcp" },
    ]);
  });

  test('"/" 全部候选含 mcp（词表末位）', () => {
    const all = slashSuggestions("/");
    expect(all).toContainEqual({ kind: "command", command: "mcp" });
    expect(all[all.length - 1]).toEqual({
      kind: "command",
      command: "mcp",
    });
  });

  test('/mcp 唯一匹配 → 补全 "/mcp "（尾随空格）', () => {
    expect(slashComplete("/mcp")).toBe("/mcp ");
  });

  test("hint 描述：查看 MCP 服务看板", () => {
    expect(slashHintLines(["mcp"])).toEqual([
      { command: "mcp", description: "查看 MCP 服务看板" },
    ]);
  });

  test("/help 含 /mcp 真描述且无 emoji；parseSkillLoad('/mcp') → undefined", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/mcp");
    expect(joined).toContain("查看 MCP 服务看板");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
    // 静态命令优先：/mcp 精确命中词表 → parseSkillLoad 返回 undefined。
    expect(
      parseSkillLoad("/mcp", [{ name: "mcp-helper", description: "x" }])
    ).toBeUndefined();
  });
});

/**
 * #377 系列 /effort：调整思考强度。词表新增第 8 条（紧邻 /thinking 之后），

 * 命令本身无 arg 语义（parseTuiInput 仍判 command），level 由 parseEffortLevel
 * 单独解析：/effort <low|medium|high|xhigh|max>（5 档 concrete，不含 ""/auto）。
 */
describe("#377 系列 /effort 词表", () => {
  test("/effort → command effort（parseTuiInput 仍判 command）", () => {
    expect(parseTuiInput("/effort")).toEqual({
      kind: "command",
      command: "effort",
    });
    expect(parseTuiInput("  /EFFORT  ")).toEqual({
      kind: "command",
      command: "effort",
    });
  });

  test('"/" 全部候选含 effort（紧邻 thinking 之后）', () => {
    const all = slashSuggestions("/");
    expect(all).toContainEqual({ kind: "command", command: "effort" });
    const thinkingIdx = all.findIndex(
      (c) => c.kind === "command" && c.command === "thinking"
    );
    const effortIdx = all.findIndex(
      (c) => c.kind === "command" && c.command === "effort"
    );
    expect(effortIdx).toBe(thinkingIdx + 1);
  });

  test('"/ef" 前缀 → [{command: effort}]（唯一匹配）', () => {
    expect(slashSuggestions("/ef")).toEqual([
      { kind: "command", command: "effort" },
    ]);
  });

  test('/effort 唯一匹配 → 补全 "/effort "', () => {
    expect(slashComplete("/eff")).toBe("/effort ");
  });

  test("parseEffortLevel: /effort high → high", () => {
    expect(parseEffortLevel("/effort high")).toBe("high");
  });

  test("parseEffortLevel: 5 档 concrete 全命中", () => {
    expect(parseEffortLevel("/effort low")).toBe("low");
    expect(parseEffortLevel("/effort medium")).toBe("medium");
    expect(parseEffortLevel("/effort high")).toBe("high");
    expect(parseEffortLevel("/effort xhigh")).toBe("xhigh");
    expect(parseEffortLevel("/effort max")).toBe("max");
  });

  test("parseEffortLevel: 大小写不敏感 + trim（/effort HIGH / /effort  High  ）", () => {
    expect(parseEffortLevel("/effort HIGH")).toBe("high");
    expect(parseEffortLevel("  /effort  High  ")).toBe("high");
  });

  test('parseEffortLevel: 自适应档不在可选档位（auto / "" → undefined）', () => {
    expect(parseEffortLevel("/effort auto")).toBeUndefined();
    expect(parseEffortLevel('/effort ""')).toBeUndefined();
    expect(parseEffortLevel("/effort adaptive")).toBeUndefined();
  });

  test("parseEffortLevel: 未知档 → undefined", () => {
    expect(parseEffortLevel("/effort unknown")).toBeUndefined();
    expect(parseEffortLevel("/effort ultra")).toBeUndefined();
  });

  test("parseEffortLevel: 空 / 缺参 / 全空白 → undefined", () => {
    expect(parseEffortLevel("")).toBeUndefined();
    expect(parseEffortLevel("/effort")).toBeUndefined();
    expect(parseEffortLevel("/effort   ")).toBeUndefined();
    expect(parseEffortLevel("   ")).toBeUndefined();
  });

  test("effortHasArg: 有参数段 → true（合法/非法 concrete 档均 true）", () => {
    expect(effortHasArg("/effort low")).toBe(true);
    expect(effortHasArg("/effort auto")).toBe(true);
    expect(effortHasArg("/effort unknown")).toBe(true);
    expect(effortHasArg("  /effort  High  ")).toBe(true);
  });

  test("effortHasArg: 无参数段 → false（空 / 缺参 / 全空白）", () => {
    expect(effortHasArg("")).toBe(false);
    expect(effortHasArg("/effort")).toBe(false);
    expect(effortHasArg("/effort   ")).toBe(false);
    expect(effortHasArg("   ")).toBe(false);
  });

  test("helpLines 含 /effort 行（紧邻 /thinking 之后）且列全 5 档名称", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/effort");
    expect(joined).toContain("low");
    expect(joined).toContain("medium");
    expect(joined).toContain("high");
    expect(joined).toContain("xhigh");
    expect(joined).toContain("max");
    const thinkingLineIdx = joined
      .split("\n")
      .findIndex((l) => l.startsWith("/thinking"));
    const effortLineIdx = joined
      .split("\n")
      .findIndex((l) => l.startsWith("/effort"));
    expect(effortLineIdx).toBe(thinkingLineIdx + 1);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test("HINT_DESCRIPTIONS.effort === 调整思考强度", () => {
    expect(slashHintLines(["effort"])).toEqual([
      { command: "effort", description: "调整思考强度" },
    ]);
  });
});
