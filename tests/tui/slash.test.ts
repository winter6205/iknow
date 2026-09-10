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
  slashHasArg,
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
    ["/memory", "memory"],
    ["/compact", "compact"],
    ["/continue", "continue"],
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
  test("覆盖全部 14 条词表命令 + Ctrl+C 说明 + 鼠标拖选提示，且无 emoji；Ctrl+Y 已移除", () => {
    const joined = helpLines().join("\n");
    for (const cmd of [
      "/sessions",
      "/new",
      "/mcp",
      "/info",
      "/help",
      "/thinking",
      "/effort",
      "/memory",
      "/quit",
      "/exit",
      "/compact",
      "/continue",
      "/rewind",
      "/graph",
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

  test('"/" → 全部 14 条静态命令（按词表插入顺序，kind="command"；rewind + mcp + graph，无 /profile）', () => {
    expect(slashSuggestions("/")).toEqual([
      { kind: "command", command: "sessions" },
      { kind: "command", command: "new" },
      { kind: "command", command: "quit" },
      { kind: "command", command: "exit" },
      { kind: "command", command: "help" },
      { kind: "command", command: "info" },
      { kind: "command", command: "thinking" },
      { kind: "command", command: "effort" },
      { kind: "command", command: "memory" },
      { kind: "command", command: "compact" },
      { kind: "command", command: "continue" },
      { kind: "command", command: "rewind" },
      { kind: "command", command: "mcp" },
      { kind: "command", command: "graph" },
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
      { kind: "command", command: "memory" },
      { kind: "command", command: "compact" },
      { kind: "command", command: "continue" },
      { kind: "command", command: "rewind" },
      { kind: "command", command: "mcp" },
      { kind: "command", command: "graph" },
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
      { kind: "command", command: "continue" },
      { kind: "skill", name: "compact-wizard", description: "压缩向导" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("skill 无 description → description 缺省（undefined）", () => {
    expect(slashSuggestions("/ba", [{ name: "bash-doc" }])).toEqual([
      { kind: "skill", name: "bash-doc", description: undefined },
    ]);
  });

  test('"/c" 混合：静态命令（compact/continue）在前 + skill（code-review）在后', () => {
    expect(
      slashSuggestions("/c", [{ name: "code-review", description: "代码审查" }])
    ).toEqual([
      { kind: "command", command: "compact" },
      { kind: "command", command: "continue" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("无前缀命中的 skill 不出现", () => {
    // Task 4：typed `/echo` 精确命中唯一 skill → 消歧列表为空（zzz 既不
    // 命中前缀也不该出现；不再返回 echo 自身——已无歧义可消）。
    expect(
      slashSuggestions("/echo", [
        { name: "echo", description: "回声" },
        { name: "zzz", description: "不匹配" },
      ])
    ).toEqual([]);
  });
});

describe('slashComplete: 唯一匹配 → "/cmd "；0 匹配 → null；≥2 匹配 → LCP 无进展 → null', () => {
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

/**
 * fix/tui-input-issues：slashComplete 三态语义（shell-like 部分补全）。
 *  1) 唯一匹配 → `/{label} `（带尾随空格，原契约不变）；
 *  2) 0 匹配 → null；
 *  3) ≥2 匹配 → 候选补全形（`/{command}` / `/{skill.name}` 原始大小写）的
 *     最长公共前缀（LCP）有进展（长于已输入前缀，或等长但大小写不同 →
 *     规范化为候选大小写）→ 返回 LCP **不带尾随空格**（bash 式部分补全，
 *     剩余歧义由 hint UI 展示）；无进展 → null。
 */
describe("slashComplete: 三态语义（唯一 → 尾随空格；多匹配 → LCP 部分补全）", () => {
  test('"/q" → "/quit "（唯一匹配 + 尾随空格，回归守卫）', () => {
    expect(slashComplete("/q")).toBe("/quit ");
  });

  test('"/ex" → "/exit "（唯一）', () => {
    expect(slashComplete("/ex")).toBe("/exit ");
  });

  test('"/ef" → "/effort "（唯一）', () => {
    expect(slashComplete("/ef")).toBe("/effort ");
  });

  test('"/e" → null（exit + effort 共 2 匹配，LCP "/e" 无进展）', () => {
    expect(slashComplete("/e")).toBeNull();
  });

  test('裸 "/" → null（11 命令，LCP "/" 无进展）', () => {
    expect(slashComplete("/")).toBeNull();
  });

  test('"/zzz" → null（0 匹配）', () => {
    expect(slashComplete("/zzz")).toBeNull();
  });

  test("多匹配有公共进展：/foo + skills foo-one/foo-two → LCP '/foo-'（不带尾随空格）", () => {
    expect(
      slashComplete("/foo", [
        { name: "foo-one", description: "x" },
        { name: "foo-two", description: "y" },
      ])
    ).toBe("/foo-");
  });

  test("LCP 保留候选原始大小写：skills Echo/Echo-extra + '/Ec' → '/Echo'（不带尾随空格）", () => {
    expect(
      slashComplete("/Ec", [
        { name: "Echo", description: "回声" },
        { name: "Echo-extra", description: "x" },
      ])
    ).toBe("/Echo");
  });

  test("等长但大小写不同 → 规范化为候选大小写 + 尾随空格：'/Echo' → '/Echo '（非 null）", () => {
    // Task 4 守卫：typed 是某候选的精确命中（仅大小写不同）+ 存在更长兄弟
    // → slashComplete 必须返回尾随空格形式（与 unique 精确命中同契约），便
    // 于用户追加 remainder。
    expect(
      slashComplete("/Echo", [
        { name: "Echo", description: "回声" },
        { name: "Echo-extra", description: "x" },
      ])
    ).toBe("/Echo ");
    expect(
      slashComplete("/ECHO", [
        { name: "Echo", description: "回声" },
        { name: "Echo-extra", description: "x" },
      ])
    ).toBe("/Echo ");
  });

  test("大小写不敏感输入仍走长度进展：'/EC'（typed '/ec' < LCP '/Echo'）→ '/Echo'", () => {
    expect(
      slashComplete("/EC", [
        { name: "Echo", description: "回声" },
        { name: "Echo-extra", description: "x" },
      ])
    ).toBe("/Echo");
  });

  test("跨静态命令 + skill 多匹配无进展 → null（'/e' + echo：LCP '/e' == typed）", () => {
    expect(
      slashComplete("/e", [{ name: "echo", description: "回声" }])
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
    "continue",
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

  test("cursor=9 → /continue （词表第 10 条）", () => {
    expect(slashCompleteFromList(ALL, 9)).toBe("/continue ");
  });

  test("cursor=10 → /rewind （词表第 11 条）", () => {
    expect(slashCompleteFromList(ALL, 10)).toBe("/rewind ");
  });

  test("cursor=11 → /mcp （词表末条，append-only）", () => {
    expect(slashCompleteFromList(ALL, 11)).toBe("/mcp ");
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

  test("hint 描述：Compact context（外显文案英文化）", () => {
    expect(slashHintLines(["compact"])).toEqual([
      { command: "compact", description: "Compact context" },
    ]);
  });

  test("/help 覆盖 /compact 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/compact");
    // help 行与 column 对齐（/compact 后 3 空格起描述）。
    expect(joined).toContain(
      "/compact   Compact context (keep tail, trim early messages)"
    );
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

  test('"/m" 前缀 → mcp 与 memory 两个候选', () => {
    expect(slashSuggestions("/m")).toEqual([
      { kind: "command", command: "memory" },
      { kind: "command", command: "mcp" },
    ]);
  });

  test('"/" 全部候选含 mcp（词表 append-only：/graph 追加后 mcp 退居倒二）', () => {
    const all = slashSuggestions("/");
    expect(all).toContainEqual({ kind: "command", command: "mcp" });
    expect(all[all.length - 2]).toEqual({
      kind: "command",
      command: "mcp",
    });
    expect(all[all.length - 1]).toEqual({
      kind: "command",
      command: "graph",
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

/** T4 (#690): /continue — 续跑未完成工具环（skip-append）。 */
describe("/continue 词表", () => {
  test("/continue → command continue", () => {
    expect(parseTuiInput("/continue")).toEqual({
      kind: "command",
      command: "continue",
    });
  });

  test("大小写与空白容忍", () => {
    expect(parseTuiInput("  /CONTINUE  ")).toEqual({
      kind: "command",
      command: "continue",
    });
  });

  test("带参数仍命中命令（args 由宿主 usage EXIT，不把 slash 当 message）", () => {
    expect(parseTuiInput("/continue now")).toEqual({
      kind: "command",
      command: "continue",
    });
    expect(slashHasArg("/continue now")).toBe(true);
    expect(slashHasArg("/continue")).toBe(false);
    expect(slashHasArg("  /CONTINUE  ")).toBe(false);
  });

  test('"/con" 前缀 → [{command: continue}]（不与 compact 冲突）', () => {
    expect(slashSuggestions("/con")).toEqual([
      { kind: "command", command: "continue" },
    ]);
  });

  test('/continue 唯一匹配 → 补全 "/continue "', () => {
    expect(slashComplete("/cont")).toBe("/continue ");
  });

  test("hint 描述：续跑未完成的工具环", () => {
    expect(slashHintLines(["continue"])).toEqual([
      { command: "continue", description: "续跑未完成的工具环" },
    ]);
  });

  test("/help 覆盖 /continue 且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/continue");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test("命中静态命令 → undefined（/continue 不抢 skill-load）", () => {
    expect(
      parseSkillLoad("/continue", [{ name: "continue-task", description: "x" }])
    ).toBeUndefined();
  });
});

describe("/memory 词表", () => {
  test("/memory → command memory", () => {
    expect(parseTuiInput("/memory")).toEqual({
      kind: "command",
      command: "memory",
    });
  });

  test('"/" 全部候选含 memory（紧邻 effort 之后）', () => {
    const all = slashSuggestions("/");
    const effortIdx = all.findIndex(
      (c) => c.kind === "command" && c.command === "effort"
    );
    const memoryIdx = all.findIndex(
      (c) => c.kind === "command" && c.command === "memory"
    );
    expect(memoryIdx).toBe(effortIdx + 1);
  });

  test("/help 含 /memory 行", () => {
    expect(helpLines().join("\n")).toContain("/memory");
  });
});

/**
 * Task 4（plans/tui-chrome-interaction.md）：slash hint 仅作**消歧**。
 *  - 唯一精确命中（skill 或静态命令）→ 空列表（即便没有更长兄弟）。
 *  - 精确命中 + 空格/remainder → 空列表（即便有更长兄弟）。
 *  - 前缀歧义（`/way` → 两个 skill）→ 列表保留。
 *  - 精确命中无空格但有更长兄弟 → 只显示更长兄弟，不显示已完整的名字。
 *  - mixed-case 精确命中仍隐藏（大小写不敏感匹配契约）。
 *  Tab/Enter 路径（slashComplete）保持不变 —— 见下方 slashComplete 测试。
 */
describe("Task 4：slashSuggestions 仅显示未消歧的兄弟（disambig-only）", () => {
  test("unique `/skillname`（skill 唯一精确命中，无 remainder）→ 0 hint rows", () => {
    expect(
      slashSuggestions("/echo", [{ name: "echo", description: "回声" }])
    ).toEqual([]);
  });

  test("`/skillname remainder`（skill 精确命中 + 空格）→ 0 hint rows（即便有更长兄弟）", () => {
    expect(
      slashSuggestions("/echo 你好", [
        { name: "echo", description: "回声" },
        { name: "echo-extra", description: "x" },
      ])
    ).toEqual([]);
  });

  test("`/skillname remainder`（仅 tab 分隔的多段）→ 0 hint rows", () => {
    expect(
      slashSuggestions("/echo   帮我做 X", [
        { name: "echo", description: "回声" },
      ])
    ).toEqual([]);
  });

  test("unique `/static-cmd`（静态命令唯一精确命中）→ 0 hint rows", () => {
    // /quit 在 prefix=/q 时唯一 → 完整命中 /quit 后必须隐藏。
    expect(slashSuggestions("/quit")).toEqual([]);
  });

  test("`/quit remainder` → 0 hint rows（精确命中 + 空格）", () => {
    expect(slashSuggestions("/quit 现在")).toEqual([]);
  });

  test("mixed-case 精确命中 `/ECHO`（大小写不敏感）→ 0 hint rows", () => {
    expect(
      slashSuggestions("/ECHO", [{ name: "echo", description: "回声" }])
    ).toEqual([]);
    expect(
      slashSuggestions("/Echo", [{ name: "echo", description: "回声" }])
    ).toEqual([]);
  });

  test("mixed-case 精确命中 + remainder `/ECHO foo` → 0 hint rows", () => {
    expect(
      slashSuggestions("/ECHO foo", [{ name: "echo", description: "回声" }])
    ).toEqual([]);
  });

  test("前缀歧义 `/way`（两个 skill 共享前缀）→ 列表保留两个", () => {
    expect(
      slashSuggestions("/way", [
        { name: "way-foo", description: "foo" },
        { name: "way-bar", description: "bar" },
      ])
    ).toEqual([
      { kind: "skill", name: "way-foo", description: "foo" },
      { kind: "skill", name: "way-bar", description: "bar" },
    ]);
  });

  test("前缀歧义 `/e`（exit + effort 两个静态命令）→ 列表保留", () => {
    // 回归守卫：保留 /e 的二义性行为（不与 Task 4 冲突）。
    expect(slashSuggestions("/e")).toEqual([
      { kind: "command", command: "exit" },
      { kind: "command", command: "effort" },
    ]);
  });

  test("精确命中 + 更长兄弟（skill：echo + echo-extra，typed `/echo`）→ 只显示 echo-extra", () => {
    expect(
      slashSuggestions("/echo", [
        { name: "echo", description: "回声" },
        { name: "echo-extra", description: "x" },
      ])
    ).toEqual([{ kind: "skill", name: "echo-extra", description: "x" }]);
  });

  test("精确命中 + 更长兄弟（skill：mixed-case Echo + Echo-extra，typed `/Echo`）→ 只显示 Echo-extra", () => {
    expect(
      slashSuggestions("/Echo", [
        { name: "Echo", description: "回声" },
        { name: "Echo-extra", description: "x" },
      ])
    ).toEqual([{ kind: "skill", name: "Echo-extra", description: "x" }]);
  });

  test("精确命中 + 更长兄弟（静态命令：/comp 不会精确命中任何命令 → 保留 prefix 行为）", () => {
    // /comp 是 compact 的前缀（不是精确），slashSuggestions 必须保留。
    expect(slashSuggestions("/comp")).toEqual([
      { kind: "command", command: "compact" },
    ]);
  });

  test("精确命中静态命令 + 同前缀 skill 兄弟 → 只显示 skill 兄弟", () => {
    // typed `/compact`：精确命中静态 compact（已完整），但 skill compact-wizard
    // 仍以 compact 为前缀（更长兄弟）→ 只保留它。
    expect(
      slashSuggestions("/compact", [
        { name: "code-review", description: "代码审查" },
        { name: "compact-wizard", description: "x" },
      ])
    ).toEqual([{ kind: "skill", name: "compact-wizard", description: "x" }]);
  });

  test("未知 `/zzzz` → 0 hint rows（与原契约一致：unknown 路径）", () => {
    expect(slashSuggestions("/zzzz")).toEqual([]);
  });

  test("非 exact 前缀歧义 + remainder → 列表保留（plan T4 只授权 exact 命中清空）", () => {
    const skills = [
      { name: "way-foo", description: "foo" },
      { name: "way-bar", description: "bar" },
    ];
    expect(slashSuggestions("/way now", skills)).toEqual([
      { kind: "skill", name: "way-foo", description: "foo" },
      { kind: "skill", name: "way-bar", description: "bar" },
    ]);
  });

  test("空 / 非 `/` 开头 → 0 hint rows（边界，与原契约一致）", () => {
    expect(slashSuggestions("")).toEqual([]);
    expect(slashSuggestions("hello")).toEqual([]);
    expect(slashSuggestions("  你好  ")).toEqual([]);
  });

  test("两次 slashSuggestions 调用相互隔离（无状态泄漏）", () => {
    const skills = [
      { name: "echo", description: "回声" },
      { name: "echo-extra", description: "x" },
    ];
    const a = slashSuggestions("/echo", skills);
    const b = slashSuggestions("/way", [
      { name: "way-foo", description: "foo" },
      { name: "way-bar", description: "bar" },
    ]);
    expect(a).toEqual([
      { kind: "skill", name: "echo-extra", description: "x" },
    ]);
    expect(b).toEqual([
      { kind: "skill", name: "way-foo", description: "foo" },
      { kind: "skill", name: "way-bar", description: "bar" },
    ]);
    // 再次调用 a 应返回相同结果（无状态）。
    expect(slashSuggestions("/echo", skills)).toEqual(a);
  });

  test("`/` 空前缀 → 全部 14 条静态命令（Task 4 不影响空前缀契约）", () => {
    expect(slashSuggestions("/")).toHaveLength(14);
  });

  test("裸 `/` + skills → 静态命令全在、skill 不入场（#377 E 不变）", () => {
    expect(
      slashSuggestions("/", [
        { name: "echo", description: "回声" },
        { name: "code-review", description: "代码审查" },
      ])
    ).toEqual(
      expect.arrayContaining([
        { kind: "command", command: "quit" },
        { kind: "command", command: "graph" },
      ])
    );
    expect(
      slashSuggestions("/", [{ name: "echo", description: "回声" }])
    ).not.toContainEqual({
      kind: "skill",
      name: "echo",
      description: "回声",
    });
  });
});

/**
 * Task 4 守卫：Tab/Enter 路径（slashComplete + slashCompleteFromCandidates）
 * 保持不变 —— 即使 slashSummary 返回空，slashComplete 也必须按原契约
 * 工作（`/echo` 唯一精确命中 → `/echo `）。这意味着 slashComplete 必须
 * 使用独立于 slashSummary 的全量候选枚举，Tab 行为不被显示过滤影响。
 */
describe("Task 4 守卫：slashComplete 不受显示过滤影响", () => {
  test("unique `/echo` → `/echo `（精确命中 + 尾随空格）", () => {
    expect(
      slashComplete("/echo", [{ name: "echo", description: "回声" }])
    ).toBe("/echo ");
  });

  test("`/echo` + 更长兄弟 echo-extra → `/echo `（唯一精确匹配补全）", () => {
    expect(
      slashComplete("/echo", [
        { name: "echo", description: "回声" },
        { name: "echo-extra", description: "x" },
      ])
    ).toBe("/echo ");
  });

  test("`/echo 你好`（精确 + remainder）→ null（已提交，Tab 不动）", () => {
    expect(
      slashComplete("/echo 你好", [{ name: "echo", description: "回声" }])
    ).toBeNull();
  });

  test("mixed-case `/ECHO` → `/echo `（大小写规范化）", () => {
    expect(
      slashComplete("/ECHO", [{ name: "echo", description: "回声" }])
    ).toBe("/echo ");
  });

  test("`/q` → /quit （唯一匹配 + 尾随空格）", () => {
    expect(slashComplete("/q")).toBe("/quit ");
  });

  test("`/quit remainder` → null（已提交，Tab 不动）", () => {
    expect(slashComplete("/quit 现在")).toBeNull();
  });

  test("前缀歧义 `/e` → null（exit + effort，无进展）", () => {
    expect(slashComplete("/e")).toBeNull();
  });

  test("`/foo` + skills foo-one/foo-two → `/foo-`（LCP 部分补全）", () => {
    expect(
      slashComplete("/foo", [
        { name: "foo-one", description: "x" },
        { name: "foo-two", description: "y" },
      ])
    ).toBe("/foo-");
  });

  test("`/zzz` → null（0 匹配）", () => {
    expect(slashComplete("/zzz")).toBeNull();
  });
});

/**
 * Task 4 守卫：slashCompleteFromCandidates 的 cursor 行为。
 * 这是 hint UI 按选中项补全路径 —— 消费方（app.tsx）传入过滤后的
 * slashSummary 列表，所以 cursor 越界处理必须保持。
 */
describe("Task 4 守卫：slashCompleteFromCandidates 保持原契约", () => {
  test("空列表 + cursor=0 → null", () => {
    expect(slashCompleteFromCandidates([], 0)).toBeNull();
  });

  test("cursor 越界 → null", () => {
    const list = [{ kind: "command", command: "quit" }];
    expect(slashCompleteFromCandidates(list, -1)).toBeNull();
    expect(slashCompleteFromCandidates(list, 1)).toBeNull();
  });
});
