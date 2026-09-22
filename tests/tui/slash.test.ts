/**
 * tests/tui/slash.test.ts
 *
 * Slash-vocabulary parsing (bun:test): the TUI owns its command list and does
 * not reuse chat's processChatLine. Covers every static command + unknown
 * /xxx + plain messages + empty input + /reset being unreachable by design.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { resolveAgentCatalog } from "../../src/harness/subagent/catalog.js";
import { skillNamesForHelp, toSlashEntries } from "../../src/tui/app.js";
import {
  createSkillCatalog,
  type SkillEntry,
} from "../../src/harness/skill/catalog.js";
import { createSkillScanner } from "../../src/harness/skill/scanner.js";

describe("parseTuiInput: 词表命中", () => {
  for (const [input, command] of [
    ["/sessions", "sessions"],
    ["/new", "new"],
    ["/mcp", "mcp"],
    ["/config", "config"],
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

/**
 * Vocabulary SSOT: `slashSuggestions("/")` is the full projection of the
 * command list (empty prefix → all static commands, insertion order). Tests
 * derive "how many commands" / "which is last" from it instead of hardcoded
 * counts or indices — appending a command moves only this one derivation.
 */
function vocabularyCommands(): ReadonlyArray<string> {
  return slashSuggestions("/").map((c) =>
    c.kind === "command" ? c.command : c.name
  );
}

describe("helpLines", () => {
  test("覆盖全部词表命令 + Esc 打断/Ctrl+C 复制说明 + 鼠标拖选提示，且无 emoji；Ctrl+Y 已移除", () => {
    const joined = helpLines().join("\n");
    for (const command of vocabularyCommands()) {
      expect(joined).toContain(`/${command}`);
    }
    // key split: Esc = interrupt (double-press = rewind), Ctrl+C = copy selection.
    expect(joined).toContain("Esc");
    expect(joined).toContain("打断前台运行中的 turn");
    expect(joined).toContain("Ctrl+C");
    expect(joined).toContain("复制选中文本");
    // Ctrl+Y was removed (drag-select only highlights; right-click copies).
    expect(joined).not.toContain("Ctrl+Y");
    // mouse drag-select hint (drag highlights → right-click copies to clipboard).
    expect(joined).toContain("鼠标拖选");
    expect(joined).toContain("右键复制到剪贴板");
    // no emoji (vocabulary self-check): common emoji code ranges must be absent
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

describe("slashSuggestions: 前缀过滤 + 词表顺序（#337 Phase C → SlashCandidate 判别联合）", () => {
  test("空字符串 → 空数组", () => {
    expect(slashSuggestions("")).toEqual([]);
  });

  test('"/" → 全部静态命令（按词表插入顺序；graph 后追加 config、再追加 model、再追加 yolo，无 /profile）', () => {
    const commands = vocabularyCommands();
    expect(commands.slice(0, 14)).toEqual([
      "sessions",
      "new",
      "quit",
      "exit",
      "help",
      "info",
      "thinking",
      "effort",
      "memory",
      "compact",
      "continue",
      "rewind",
      "mcp",
      "graph",
    ]);
    expect(commands.slice(14)).toEqual(["config", "model", "yolo"]);
    expect(slashSuggestions("/")).toEqual(
      commands.map((command) => ({ kind: "command" as const, command }))
    );
    expect(commands).not.toContain("profile");
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
    ).toEqual(slashSuggestions("/"));
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

  test("skill 名前缀过滤大小写不敏感（/CO 同时命中静态 compact/continue/config + 两个 skill）", () => {
    expect(
      slashSuggestions("/CO", [
        { name: "compact-wizard", description: "压缩向导" },
        { name: "code-review", description: "代码审查" },
      ])
    ).toEqual([
      { kind: "command", command: "compact" },
      { kind: "command", command: "continue" },
      { kind: "command", command: "config" },
      { kind: "skill", name: "compact-wizard", description: "压缩向导" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("skill 无 description → description 缺省（undefined）", () => {
    expect(slashSuggestions("/ba", [{ name: "bash-doc" }])).toEqual([
      { kind: "skill", name: "bash-doc", description: undefined },
    ]);
  });

  // Spec Layer 2 item 6 (SC2 companion): the TUI slash vocabulary stays the
  // static command list — no `/general-purpose`, no `/explore`, no
  // `/<agent-id>` of any kind. Agents are reached only through the
  // `spawn_subagent` tool, so the agent catalog must never leak into this
  // vocabulary. Derived from the catalog SSOT rather than a hardcoded pair,
  // so adding a builtin agent leaves this pin meaningful.
  test("词表不含任何 agent id（agent 只经 spawn_subagent 触达，不进 slash）", () => {
    const agentIds = resolveAgentCatalog().map((e) => e.id);
    const commands = vocabularyCommands();
    expect(agentIds.length).toBeGreaterThan(0);
    for (const id of agentIds) {
      expect(commands).not.toContain(id);
      expect(slashSuggestions(`/${id}`)).toEqual([]);
    }
  });

  test('"/c" 混合：静态命令（compact/continue/config）在前 + skill（code-review）在后', () => {
    expect(
      slashSuggestions("/c", [{ name: "code-review", description: "代码审查" }])
    ).toEqual([
      { kind: "command", command: "compact" },
      { kind: "command", command: "continue" },
      { kind: "command", command: "config" },
      { kind: "skill", name: "code-review", description: "代码审查" },
    ]);
  });

  test("无前缀命中的 skill 不出现", () => {
    // typed `/echo` exact-hits the only skill → disambiguation list is empty
    // (zzz matches neither the prefix nor anything else; echo itself is no
    // longer returned — there is nothing left to disambiguate).
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
 * slashComplete tri-state semantics (shell-like partial completion):
 *  1) unique match → `/{label} ` (trailing space; original contract unchanged);
 *  2) 0 matches → null;
 *  3) ≥2 matches → if the longest common prefix (LCP) of the candidate
 *     completion forms (`/{command}` / `/{skill.name}`, original casing) makes
 *     progress (longer than the typed prefix, or same length but different
 *     casing → normalize to the candidate's casing), return the LCP **without
 *     trailing space** (bash-style partial completion; the hint UI shows the
 *     remaining ambiguity); no progress → null.
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
    // guard: typed is an exact hit of one candidate (case differs only) and a
    // longer sibling exists → slashComplete must return the trailing-space form
    // (same contract as a unique exact hit) so the user can append the remainder.
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
 * /thinking — toggles the current session's thinking-fold panel.
 * Vocabulary entry aligned with IKNOW_CHAT_SHOW_THINKING (chat-side fold summary).
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
 * right-click copy — /copy command removed (cancelled upstream); drag-select
 * only highlights, right-click copies to clipboard; Ctrl+Y copy removed.
 * helpLines keeps only the drag-select + right-click-copy notes.
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

/** /compact — manually compact the current session context (keep tail, trim early messages). */
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
    // help rows align by column (description starts 3 spaces after /compact).
    expect(joined).toContain(
      "/compact   Compact context (keep tail, trim early messages)"
    );
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

/**
 * /skill-name [prompt] parsing — exact skill-name hit → {name, remainder};
 * static-command hit / no match → undefined (static commands take priority).
 */
describe("parseSkillLoad: /skill-name [提示词] 解析", () => {
  const SKILLS = [
    { name: "echo", description: "回声" },
    { name: "code-review", description: "代码审查" },
  ];

  /** spec tui-skill-slash-catalog SC1: besides the plugin skill's canonical
   *  name, slash also accepts the unique bare alias registered in the catalog
   *  (`SkillEntryLike.aliases` = the catalog projection in app.tsx). A
   *  canonical / bare hit resolves to the same entry, and the returned name is
   *  always canonical (invariant 2: canonical preferred for display and load). */
  const PLUGIN_SKILLS = [
    {
      name: "arthurpower:using-agent-skills",
      description: "调度技能",
      aliases: ["using-agent-skills"],
    },
    { name: "echo", description: "回声" },
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

  test("字面量单斜杠 `/` → undefined（spec 入参契约：空 token 不成技能）", () => {
    // after trim the first token of `/` is empty — not any skill name, and it
    // must not be mistaken for a static command either.
    expect(parseSkillLoad("/", SKILLS)).toBeUndefined();
    expect(parseTuiInput("/")).toEqual({ kind: "unknown", raw: "/" });
  });

  test("空 skills 数组 → undefined", () => {
    expect(parseSkillLoad("/echo", [])).toBeUndefined();
  });

  test("SC1：裸名别名精确命中 → 返回规范名（canonical 优先展示，invariant 2）", () => {
    expect(parseSkillLoad("/using-agent-skills", PLUGIN_SKILLS)).toEqual({
      name: "arthurpower:using-agent-skills",
      remainder: "",
    });
  });

  test("SC1：规范名命中与裸名命中返回同一 entry 名", () => {
    expect(
      parseSkillLoad("/arthurpower:using-agent-skills", PLUGIN_SKILLS)
    ).toEqual({
      name: "arthurpower:using-agent-skills",
      remainder: "",
    });
  });

  test("invariant 5：裸名 token 后的 remainder 按**输入 token 长度**切，不按 canonical 长度", () => {
    // `using-agent-skills` = 18 chars (+`/` = 19); the canonical token is 31 —
    // cutting by skill.name.length would eat into the remainder's prefix.
    expect(parseSkillLoad("/using-agent-skills do X", PLUGIN_SKILLS)).toEqual({
      name: "arthurpower:using-agent-skills",
      remainder: "do X",
    });
    expect(
      parseSkillLoad("/arthurpower:using-agent-skills do X", PLUGIN_SKILLS)
    ).toEqual({
      name: "arthurpower:using-agent-skills",
      remainder: "do X",
    });
  });

  test("裸名别名大小写不敏感命中（/USING-Agent-Skills → 规范名）", () => {
    expect(parseSkillLoad("/USING-Agent-Skills", PLUGIN_SKILLS)).toEqual({
      name: "arthurpower:using-agent-skills",
      remainder: "",
    });
  });

  test("SC2 静态优先：skill 裸名撞上静态命令 → undefined（/help 仍是宿主 help）", () => {
    expect(
      parseSkillLoad("/help", [
        { name: "plug:help", description: "撞车", aliases: ["help"] },
      ])
    ).toBeUndefined();
    expect(
      parseSkillLoad("/compact 现在", [
        { name: "plug:compact", description: "撞车", aliases: ["compact"] },
      ])
    ).toBeUndefined();
  });

  test("未知裸名 / 未登记的别名前缀 → undefined（不误命中 canonical）", () => {
    expect(parseSkillLoad("/using-agent", PLUGIN_SKILLS)).toBeUndefined();
    expect(parseSkillLoad("/arthurpower", PLUGIN_SKILLS)).toBeUndefined();
    expect(parseSkillLoad("/nope", PLUGIN_SKILLS)).toBeUndefined();
  });

  test("无 aliases 字段的 skill（catalog 未登记裸名 / 冲突被丢）→ 只有规范名可达", () => {
    const collided = [
      {
        name: "plugA:shared",
        description: "先到者",
        aliases: [],
      },
      { name: "plugB:shared", description: "撞车被丢别名" },
    ];
    expect(parseSkillLoad("/shared", collided)).toBeUndefined();
    expect(parseSkillLoad("/plugA:shared", collided)).toEqual({
      name: "plugA:shared",
      remainder: "",
    });
    expect(parseSkillLoad("/plugB:shared", collided)).toEqual({
      name: "plugB:shared",
      remainder: "",
    });
  });
});

/**
 * spec tui-skill-slash-catalog invariant 2: the /help roster lists canonical
 * names only — once the projection carries unique bare aliases, helpLines'
 * `/<name>  加载技能` ("load skill") section still shows no bare names
 * (human-facing entries are always `plugin:skill`).
 */
describe("skillNamesForHelp: 带别名的 catalog 投影只吐 canonical 名", () => {
  test("aliases 不进 /help 名册", () => {
    // real composition: real catalog → projection (which really carries the
    // bare alias) → roster. A hand-written literal bypasses the projection: if
    // the projection ever emitted a bare name as `name` (violating invariant
    // 2), a hand-made fixture would still be green.
    const catalog = createSkillCatalog([
      {
        name: "arthurpower:using-agent-skills",
        description: "调度技能",
        dir: "/tmp/skill-fixture",
        disabled: false,
        namespace: "arthurpower",
      },
      {
        name: "echo",
        description: "回声",
        dir: "/tmp/skill-fixture",
        disabled: false,
      },
    ]);
    const projected = toSlashEntries(catalog);
    expect(projected.map((e) => e.aliases)).toEqual([
      ["using-agent-skills"],
      undefined,
    ]);
    const names = skillNamesForHelp(projected);
    expect(names).toEqual(["arthurpower:using-agent-skills", "echo"]);
    // helpLines consumes the roster: full rows use the canonical form; bare names get no row.
    const joined = helpLines(names!).join("\n");
    expect(joined).toContain("/arthurpower:using-agent-skills  加载技能");
    expect(joined).not.toContain("\n/using-agent-skills  加载技能");
  });

  test("空投影 → undefined（help 的 skill 段整体退场）", () => {
    expect(skillNamesForHelp([])).toBeUndefined();
  });
});

/**
 * spec tui-skill-slash-catalog: route A puts the alias projection in app.tsx
 * (the harness catalog interface stays untouched). Contract = the alias set is
 * unique under the same case-folding `skillHeadLowers` in `slash.ts` uses —
 * colliding groups are dropped wholesale (unavailable beats ambiguous); if the
 * uniqueness judgment and the matcher ever diverged, one keypress would land
 * on two different entries depending on input case.
 */
describe("toSlashEntries: 裸名别名投影只在唯一时登记", () => {
  const entry = (
    name: string,
    namespace?: string,
    description = "描述"
  ): SkillEntry => ({
    name,
    description,
    dir: "/tmp/skill-fixture",
    disabled: false,
    ...(namespace !== undefined ? { namespace } : {}),
  });

  test("唯一裸名 → 带 aliases；canonical 名不改写", () => {
    const catalog = createSkillCatalog([
      entry("arthurpower:using-agent-skills", "arthurpower"),
    ]);
    expect(toSlashEntries(catalog)).toEqual([
      {
        name: "arthurpower:using-agent-skills",
        description: "描述",
        aliases: ["using-agent-skills"],
      },
    ]);
  });

  test("裸名撞车 → 先到者赢拿别名，后者不拿（无第二套索引语义）", () => {
    const catalog = createSkillCatalog([
      entry("plugA:shared", "plugA"),
      entry("plugB:shared", "plugB"),
    ]);
    expect(toSlashEntries(catalog)).toEqual([
      { name: "plugA:shared", description: "描述", aliases: ["shared"] },
      // the colliding side is canonical-only: alias absent, not an empty array.
      { name: "plugB:shared", description: "描述" },
    ]);
    expect(catalog.get("shared")?.name).toBe("plugA:shared");
  });

  describe("D1: 别名集合必须在 slash 的 case-folding 语义下唯一（大小写不敏感）", () => {
    test("裸名撞车（大小写不同）→ 两条都不登记别名（宁可不可用，不可歧义）", () => {
      const catalog = createSkillCatalog([
        entry("plugA:Shared", "plugA"),
        entry("plugB:shared", "plugB"),
      ]);
      // catalog side: the bare-name Map is case-sensitive → two differently-cased
      // bare names each occupy a slot.
      expect(catalog.get("Shared")?.name).toBe("plugA:Shared");
      expect(catalog.get("shared")?.name).toBe("plugB:shared");
      // but slash matching folds both to "shared" (skillHeadLowers). If the
      // projection registered only the case-exact-unique entry, typing /shared
      // would land on plugB:shared while /Shared lands on plugA:Shared — two
      // answers under one case-folding. Contract: drop the whole group.
      expect(toSlashEntries(catalog)).toEqual([
        { name: "plugA:Shared", description: "描述" },
        { name: "plugB:shared", description: "描述" },
      ]);
    });

    test("改名撞车（非插件 skill 的规范名折成同形）→ 两侧都不登记别名", () => {
      const catalog = createSkillCatalog([
        entry("Echo"),
        entry("plug:echo", "plug"),
      ]);
      expect(catalog.get("plug:echo")?.name).toBe("plug:echo");
      // catalog's bare-name Map tolerates "Echo" and "echo" coexisting; the old
      // judgment would register plug:echo's bare alias as "echo", which folds
      // into the same token as the namespace-free "Echo" on the slash side.
      expect(toSlashEntries(catalog)).toEqual([
        { name: "Echo", description: "描述" },
        { name: "plug:echo", description: "描述" },
      ]);
    });
  });

  test("常规 skill（无 namespace）→ 不产别名", () => {
    const catalog = createSkillCatalog([entry("echo")]);
    expect(toSlashEntries(catalog)).toEqual([
      { name: "echo", description: "描述" },
    ]);
  });
});

/**
 * spec skill-index-increment SC5/SC6: the human-side slash uses the
 * **loadable-skills surface** (`catalog.loadable()`) — entries with no
 * description and with `disable-model-invocation` both become candidates; the
 * projection comes from the loadable surface, not the model-index surface
 * (the latter holds only described, non-disabled entries). This describe pins
 * the projection step (app.tsx:toSlashEntries).
 */
describe("toSlashEntries: 可加载技能面（含无 description / disable）", () => {
  const entry = (over: Partial<SkillEntry> & { name: string }): SkillEntry => ({
    dir: "/tmp/skill-fixture",
    disabled: false,
    ...over,
  });

  test("无 description 的条目进 slash 投影（description 保持 undefined）", () => {
    const catalog = createSkillCatalog([entry({ name: "no-desc" })]);
    // the model-index surface excludes it (no description) while the loadable
    // surface includes it — that split is exactly SC5's semantics: in slash,
    // not in the model index.
    expect(catalog.available().map((e) => e.name)).toEqual([]);
    expect(catalog.loadable().map((e) => e.name)).toEqual(["no-desc"]);
    expect(toSlashEntries(catalog)).toEqual([{ name: "no-desc" }]);
  });

  test("disable-model-invocation 的条目进 slash 投影（SC6：有 description 也走人侧）", () => {
    const catalog = createSkillCatalog([
      entry({
        name: "manual-only",
        description: "仅人侧",
        disabled: true,
      }),
    ]);
    expect(catalog.available().map((e) => e.name)).toEqual([]);
    expect(toSlashEntries(catalog)).toEqual([
      { name: "manual-only", description: "仅人侧" },
    ]);
  });

  test("无 description 的插件条目仍登记唯一裸名别名（别名投影不依赖 description）", () => {
    const catalog = createSkillCatalog([
      entry({ name: "plug:no-desc", namespace: "plug" }),
    ]);
    expect(toSlashEntries(catalog)).toEqual([
      { name: "plug:no-desc", aliases: ["no-desc"] },
    ]);
    const projected = toSlashEntries(catalog);
    expect(parseSkillLoad("/no-desc", projected)).toEqual({
      name: "plug:no-desc",
      remainder: "",
    });
  });

  test("loadable 面排序确定（name 升序），投影沿用同一序", () => {
    const catalog = createSkillCatalog([
      entry({ name: "zeta" }),
      entry({ name: "alpha", disabled: true }),
      entry({ name: "mid", description: "有描述" }),
    ]);
    expect(toSlashEntries(catalog).map((e) => e.name)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });
});

/** SlashCandidate-based cursor completion (static commands | skills alike). */
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
 * /mcp vocabulary closure (append-only at the tail). A static command,
 * orthogonal to parseSkillLoad (static hit → undefined, never steals
 * skill-load); real hint description + helpLines entry.
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

  test('"/m" 前缀 → memory / mcp / model 三个候选（按词表插入顺序）', () => {
    // /m is the shared prefix of three commands: memory and mcp are adjacent
    // in the vocabulary; model is appended at the tail.
    const commands = slashSuggestions("/m").map((c) =>
      c.kind === "command" ? c.command : c.name
    );
    expect(commands).toEqual(["memory", "mcp", "model"]);
  });

  test('"/mo" 前缀 → 只剩 model（消歧收敛）', () => {
    expect(slashSuggestions("/mo")).toEqual([
      { kind: "command", command: "model" },
    ]);
  });

  test('"/" 全部候选含 mcp；尾部 append-only 为 graph, config, model, yolo', () => {
    const all = slashSuggestions("/");
    expect(all).toContainEqual({ kind: "command", command: "mcp" });
    const tail = all
      .slice(-4)
      .map((c) => (c.kind === "command" ? c.command : c.name));
    expect(tail).toEqual(["graph", "config", "model", "yolo"]);
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
    // static commands win: /mcp exact-hits the vocabulary → parseSkillLoad returns undefined.
    expect(
      parseSkillLoad("/mcp", [{ name: "mcp-helper", description: "x" }])
    ).toBeUndefined();
  });
});

/**
 * /effort: adjust thinking effort, inserted right after /thinking.
 * The command itself takes no arg (parseTuiInput still yields command); the
 * level is parsed separately by parseEffortLevel:
 * /effort <low|medium|high|xhigh|max> (5 concrete tiers, no ""/auto).
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

/**
 * ADR-0092: `/config` (filesystem isolation mode switch) — vocabulary-level
 * assertions. The command SSOT lives in `src/harness/sandbox/fs-mode.ts`
 * (`parseConfigCommand` / `applyFsModeCommand` / `formatFsModeStatus` /
 * `splitConfigArgs` + `ConfigCommand` / `FsModeCommandResult` / `FS_MODE_USAGE_TEXT`).
 * This describe locks only the slash.ts vocabulary surface, complementing the
 * command SSOT's unit tests.
 */
describe("/config 词表（ADR-0092 / SC13）", () => {
  test("parseTuiInput 认 /config（带参也命中同一命令）", () => {
    expect(parseTuiInput("/config")).toEqual({
      kind: "command",
      command: "config",
    });
    expect(parseTuiInput("/config status")).toEqual({
      kind: "command",
      command: "config",
    });
    expect(parseTuiInput("/config fs workspace")).toEqual({
      kind: "command",
      command: "config",
    });
  });

  test('"/c" 前缀命中 config（与 compact / continue / code-review 共存）', () => {
    const all = slashSuggestions("/c");
    expect(all).toContainEqual({ kind: "command", command: "config" });
  });

  test('"/con" 前缀 → continue + config（config 与 continue 共享 /con 前缀）', () => {
    expect(slashSuggestions("/con")).toEqual([
      { kind: "command", command: "continue" },
      { kind: "command", command: "config" },
    ]);
  });

  test('/config 唯一匹配 → 补全 "/config "（尾随空格）', () => {
    expect(slashComplete("/config")).toBe("/config ");
  });

  test("helpLines 列出 /config（含 status|fs global|fs workspace 提示）", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/config");
    expect(joined).toMatch(/fs/);
  });

  test("HINT_DESCRIPTIONS.config 含「文件系统隔离档」短描述", () => {
    expect(slashHintLines(["config"])).toEqual([
      {
        command: "config",
        description: "文件系统隔离档（status|fs global|fs workspace）",
      },
    ]);
  });
});

/** /continue — resume an unfinished tool loop (skip-append). */
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

  test('"/con" 前缀 → [{command: continue}]（不与 compact 冲突；config 见 /config 词表用）', () => {
    expect(slashSuggestions("/con")).toEqual([
      { kind: "command", command: "continue" },
      { kind: "command", command: "config" },
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
 * /model vocabulary (ADR-0093): a new command must go the regular vocabulary
 * route (parse → candidates → completion → help / hint), no side channels.
 */
describe("/model 词表", () => {
  test("/model → command model", () => {
    expect(parseTuiInput("/model")).toEqual({
      kind: "command",
      command: "model",
    });
  });

  test("大小写不敏感：/MODEL、/Model → 同一命令", () => {
    expect(parseTuiInput("/MODEL")).toEqual({
      kind: "command",
      command: "model",
    });
    expect(parseTuiInput("/Model")).toEqual({
      kind: "command",
      command: "model",
    });
  });

  test("带参数仍命中命令（/model foo 由宿主判定，不落 unknown）", () => {
    expect(parseTuiInput("/model foo")).toEqual({
      kind: "command",
      command: "model",
    });
  });

  test('"/mod" 前缀命中 model；"/mode" 同（model 是唯一 /mod* 命令）', () => {
    expect(slashSuggestions("/mod")).toEqual([
      { kind: "command", command: "model" },
    ]);
    expect(slashSuggestions("/mode")).toEqual([
      { kind: "command", command: "model" },
    ]);
  });

  test("拼错前缀不误命中：/models → 空数组（无前缀兄弟）", () => {
    expect(slashSuggestions("/models")).toEqual([]);
  });

  test('唯一匹配 → 补全 "/model "（尾随空格）', () => {
    expect(slashComplete("/mod")).toBe("/model ");
    expect(slashComplete("/mode")).toBe("/model ");
  });

  test("hint 描述：切换模型", () => {
    expect(slashHintLines(["model"])).toEqual([
      { command: "model", description: "切换模型" },
    ]);
  });

  test("/help 含 /model 行与描述，且无 emoji", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/model");
    expect(joined).toContain("切换模型");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test("词表尾部 append-only 纪律：model 之后只追加 yolo，既有命令顺序不动", () => {
    const all = slashSuggestions("/");
    expect(all.slice(-2)).toEqual([
      { kind: "command", command: "model" },
      { kind: "command", command: "yolo" },
    ]);
  });

  test("命中静态命令 → undefined（/model 不抢 skill-load）", () => {
    expect(
      parseSkillLoad("/model", [{ name: "model-router", description: "x" }])
    ).toBeUndefined();
  });

  test("精确命中 /model 且有更长 skill 兄弟 → 只显示 skill（消歧契约不变）", () => {
    expect(
      slashSuggestions("/model", [{ name: "model-router", description: "x" }])
    ).toEqual([{ kind: "skill", name: "model-router", description: "x" }]);
  });
});

/**
 * The slash hint list is for **disambiguation only**:
 *  - unique exact hit (skill or static command) → empty list (even with no longer sibling).
 *  - exact hit + space/remainder → empty list (even with longer siblings).
 *  - prefix ambiguity (`/way` → two skills) → list kept.
 *  - exact hit without a space but with a longer sibling → show only the
 *    longer sibling, not the already-complete name.
 *  - mixed-case exact hit still hidden (case-insensitive matching contract).
 * Tab/Enter path (slashComplete) unchanged — see the slashComplete tests below.
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
    // /quit is unique at prefix=/q → once /quit is fully typed it must hide.
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
    // regression guard: keep /e's ambiguity behavior (no conflict with the disambiguation rule).
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
    // /comp is a prefix of compact (not an exact hit) → slashSuggestions must keep it.
    expect(slashSuggestions("/comp")).toEqual([
      { kind: "command", command: "compact" },
    ]);
  });

  test("精确命中静态命令 + 同前缀 skill 兄弟 → 只显示 skill 兄弟", () => {
    // typed `/compact`: exact hit on static compact (already complete), but skill
    // compact-wizard still extends compact (longer sibling) → keep only it.
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
    // calling again must return the same result (stateless).
    expect(slashSuggestions("/echo", skills)).toEqual(a);
  });

  test("`/` 空前缀 → 全部静态命令（条数 = /help 词表覆盖面，Task 4 不影响空前缀契约）", () => {
    const all = slashSuggestions("/");
    expect(all.length).toBeGreaterThan(0);
    for (const candidate of all) {
      expect(candidate.kind).toBe("command");
      expect(helpLines().join("\n")).toContain(
        `/${candidate.kind === "command" ? candidate.command : ""}`
      );
    }
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
 * spec tui-skill-slash-catalog SC1 / SC3: bare aliases enter candidates + Tab
 * completion.
 *  - prefix filtering looks at both canonical and aliases (case-insensitive);
 *  - emit **only** the canonical candidate (one skill must not appear twice via
 *    its bare name — otherwise a unique hit degrades into the ≥2-match LCP
 *    branch and Tab can't produce the trailing space);
 *  - Tab (slashComplete) on a unique bare-name match → canonical name + trailing space.
 */
describe("SC1/SC3：裸名别名进候选（canonical 展示）与 Tab 补全", () => {
  const PLUGIN_SKILLS = [
    {
      name: "arthurpower:using-agent-skills",
      description: "调度技能",
      aliases: ["using-agent-skills"],
    },
    {
      name: "arthurpower:boundary-testing",
      description: "边界测试",
      aliases: ["boundary-testing"],
    },
  ];

  test("裸名前缀过滤命中；候选 name 是规范名（SC3 展示 canonical）", () => {
    expect(slashSuggestions("/us", PLUGIN_SKILLS)).toMatchObject([
      {
        kind: "skill",
        name: "arthurpower:using-agent-skills",
        description: "调度技能",
      },
    ]);
    expect(slashSuggestions("/using-agent", PLUGIN_SKILLS)).toMatchObject([
      {
        kind: "skill",
        name: "arthurpower:using-agent-skills",
        description: "调度技能",
      },
    ]);
  });

  test("canonical 前缀过滤同样命中（新旧入口一致）", () => {
    expect(slashSuggestions("/arthurpower:usi", PLUGIN_SKILLS)).toMatchObject([
      {
        kind: "skill",
        name: "arthurpower:using-agent-skills",
        description: "调度技能",
      },
    ]);
  });

  test("裸名大小写不敏感（/USING → 规范名候选）", () => {
    expect(slashSuggestions("/USING", PLUGIN_SKILLS)).toMatchObject([
      {
        kind: "skill",
        name: "arthurpower:using-agent-skills",
        description: "调度技能",
      },
    ]);
  });

  test("canonical 与裸名同时前缀命中 → 只发一条候选（重复条会把唯一匹配退化成 LCP）", () => {
    // plugin name and bare name share the prefix (code:code-review /
    // code-review): pushing once per name-match would yield two candidates for
    // one skill → matches.length = 2 → Tab takes the LCP branch and can't
    // produce the trailing space.
    const overlapping = [
      {
        name: "code:code-review",
        description: "审查",
        aliases: ["code-review"],
      },
    ];
    // toMatchObject on an array also pins the row count (one extra row fails).
    expect(slashSuggestions("/code", overlapping)).toMatchObject([
      { kind: "skill", name: "code:code-review", description: "审查" },
    ]);
    expect(slashComplete("/code", overlapping)).toBe("/code:code-review ");
  });

  test("唯一裸名 Tab → 规范名 + 尾随空格（SC1 同一 entry）", () => {
    expect(slashComplete("/using-agent-sk", PLUGIN_SKILLS)).toBe(
      "/arthurpower:using-agent-skills "
    );
    expect(slashComplete("/us", PLUGIN_SKILLS)).toBe(
      "/arthurpower:using-agent-skills "
    );
  });

  test("唯一规范名 Tab → 规范名 + 尾随空格（canonical 路径不变）", () => {
    expect(slashComplete("/arthurpower:usi", PLUGIN_SKILLS)).toBe(
      "/arthurpower:using-agent-skills "
    );
  });

  test("裸名精确命中 + 更长兄弟 → Tab 补精确那条规范名（exact 分支，不退回 LCP）", () => {
    const siblings = [
      { name: "plug:alpha", description: "a", aliases: ["alpha"] },
      { name: "plug:alphabeta", description: "b", aliases: ["alphabeta"] },
    ];
    expect(slashComplete("/alpha", siblings)).toBe("/plug:alpha ");
  });

  test("≥2 裸名兄弟无精确命中 → LCP 取 canonical 补全形（三态语义不放宽）", () => {
    expect(slashComplete("/", PLUGIN_SKILLS)).toBeNull();
    expect(
      slashComplete("/alph", [
        { name: "plug:alpha", description: "a", aliases: ["alpha"] },
        { name: "plug:alphabeta", description: "b", aliases: ["alphabeta"] },
      ])
    ).toBe("/plug:alpha");
  });

  test("裸名精确命中 + 更长兄弟 → 消歧只留兄弟（exactness 认裸名）", () => {
    const siblings = [
      { name: "plug:alpha", description: "a", aliases: ["alpha"] },
      { name: "plug:alphabeta", description: "b", aliases: ["alphabeta"] },
    ];
    expect(slashSuggestions("/alpha", siblings)).toMatchObject([
      { kind: "skill", name: "plug:alphabeta", description: "b" },
    ]);
  });

  test("裸名精确命中且无兄弟 → 候选清空（消歧完成）", () => {
    expect(slashSuggestions("/using-agent-skills", PLUGIN_SKILLS)).toEqual([]);
    expect(slashSuggestions("/boundary-testing", PLUGIN_SKILLS)).toEqual([]);
  });

  test("裸名精确命中 + remainder → 候选清空（已提交，消歧不再有意义）", () => {
    expect(slashSuggestions("/using-agent-skills do X", PLUGIN_SKILLS)).toEqual(
      []
    );
  });

  test("SC2：裸名撞静态命令 → Tab 补静态命令（静态优先），技能只能走规范名", () => {
    const colliding = [
      { name: "plug:help", description: "撞车技能", aliases: ["help"] },
    ];
    expect(slashComplete("/help", colliding)).toBe("/help ");
    expect(slashComplete("/plug:help", colliding)).toBe("/plug:help ");
  });

  test("0 匹配 → null（未登记裸名不补全）", () => {
    expect(slashComplete("/zzz", PLUGIN_SKILLS)).toBeNull();
    expect(slashComplete("/using-agent-x", PLUGIN_SKILLS)).toBeNull();
  });

  test("agents 不进斜杠：真实插件布局里 agents 目录不进 skill catalog", async () => {
    // spec invariant 6 / CONTEXT rule "agents never enter the
    // slash". Assembly = real plugin layout: skills/ and agents/ side by side
    // under one plugin, the scanner only consumes the skills root — if a future
    // scan swept agents/ into the catalog (or slash opened its own agent path),
    // the assertions below fail.
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-agents-"));
    const skillsRoot = join(root, "arthurpower", "skills");
    await mkdir(join(skillsRoot, "using-agent-skills"), { recursive: true });
    await writeFile(
      join(skillsRoot, "using-agent-skills", "SKILL.md"),
      "---\nname: using-agent-skills\ndescription: 调度技能\n---\nbody",
      "utf8"
    );
    const agentsRoot = join(root, "arthurpower", "agents");
    await mkdir(agentsRoot, { recursive: true });
    await writeFile(
      join(agentsRoot, "code-reviewer-agent.md"),
      "---\nname: code-reviewer-agent\ndescription: 审代码\n---\nbody",
      "utf8"
    );
    try {
      const entries = await createSkillScanner({
        userHome: join(root, "home"),
        projectIdentityRoot: join(root, "project"),
        env: {},
        pluginSkillDirs: [{ dir: skillsRoot, plugin: "arthurpower" }],
      }).scan();
      const catalog = createSkillCatalog(entries);
      const projected = toSlashEntries(catalog);
      // agent names absent from the projection: neither canonical nor bare can
      // enter candidates/completion.
      // the catalog itself holds no agents: agents/ is a separate discovery
      // path, outside the skill scan.
      expect(catalog.all().map((e) => e.name)).toEqual([
        "arthurpower:using-agent-skills",
      ]);
      expect(catalog.get("code-reviewer-agent")).toBeUndefined();
      expect(catalog.get("arthurpower:code-reviewer-agent")).toBeUndefined();
      const heads = projected.flatMap((e) => [e.name, ...(e.aliases ?? [])]);
      expect(heads).toEqual([
        "arthurpower:using-agent-skills",
        "using-agent-skills",
      ]);
      expect(slashSuggestions("/code-reviewer", projected)).toEqual([]);
      expect(slashComplete("/code-reviewer-agent", projected)).toBeNull();
      expect(slashComplete("/arthurpower:code-reviewer-agent")).toBeNull();
      expect(parseSkillLoad("/code-reviewer-agent", projected)).toBeUndefined();
      expect(
        parseSkillLoad("/arthurpower:code-reviewer-agent", projected)
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Guard: the Tab/Enter path (slashComplete + slashCompleteFromCandidates)
 * stays unchanged — even when slashSummary returns empty, slashComplete must
 * work by the original contract (`/echo` unique exact hit → `/echo `). So
 * slashComplete must enumerate full candidates independently of slashSummary;
 * Tab behavior is never affected by the display filter.
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
 * Guard: slashCompleteFromCandidates cursor behavior. This is the hint UI's
 * complete-by-selected-entry path — the consumer (app.tsx) passes the filtered
 * slashSummary list, so out-of-range cursor handling must stay intact.
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
