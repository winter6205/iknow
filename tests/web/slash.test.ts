/**
 * tests/web/slash.test.ts
 *
 * web/src/lib/slash.ts 纯函数全路径：matchSlash（合法 / 非法 / 参数 /
 * 大小写）、slashCandidates（前缀补全）、slashEnterAction（execute /
 * accept / none）、slashSubmitDecision（非法命令 notice 裁决）、
 * menuKeyEvent（菜单键盘裁决）、resolveArgCommand（带参命令值域判定）、
 * slashHelpText。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  ARG_COMMAND_SPECS,
  matchSlash,
  menuKeyEvent,
  resolveArgCommand,
  slashCandidates,
  slashEnterAction,
  slashHelpText,
  slashSubmitDecision,
  parseSkillLoad,
  SLASH_COMMANDS,
  UNKNOWN_SLASH_NOTICE,
} from "../../web/src/lib/slash.ts";

describe("matchSlash — 合法命令", () => {
  it("SLASH_COMMANDS 全部条目无参或带参均可匹配（动态跟随词表扩容）", () => {
    for (const cmd of SLASH_COMMANDS) {
      const m = matchSlash(`/${cmd.name}`);
      assert.ok(m !== null, `/${cmd.name} must match`);
      assert.equal(m?.name, cmd.name);
    }
  });

  it("命令名大小写不敏感（对齐 TUI parseTuiInput 口径）", () => {
    const m = matchSlash("/COMPACT");
    assert.equal(m?.name, "compact");
  });

  it("前后空白 trim 后匹配", () => {
    const m = matchSlash("  /new  ");
    assert.deepEqual(m, { name: "new", arg: "" });
  });

  it("带参命令返回 arg（trim 后剩余段）", () => {
    assert.deepEqual(matchSlash("/thinking on"), {
      name: "thinking",
      arg: "on",
    });
    assert.deepEqual(matchSlash("/effort  high  "), {
      name: "effort",
      arg: "high",
    });
  });

  it("带参命令无参仍匹配（arg 空串，合法性由 App 裁决）", () => {
    assert.deepEqual(matchSlash("/thinking"), { name: "thinking", arg: "" });
    assert.deepEqual(matchSlash("/effort"), { name: "effort", arg: "" });
  });
});

describe("matchSlash — 非法输入 → null", () => {
  it("不以 / 开头 → null", () => {
    assert.equal(matchSlash("hello"), null);
    assert.equal(matchSlash(""), null);
    assert.equal(matchSlash("   "), null);
  });

  it("未知命令 → null", () => {
    assert.equal(matchSlash("/unknown x"), null);
    assert.equal(matchSlash("/zzz"), null);
  });

  it("无参命令携带多余参数 → null（裁决：非法，不执行也不发送）", () => {
    assert.equal(matchSlash("/compact 多余参数"), null);
    assert.equal(matchSlash("/new x"), null);
    assert.equal(matchSlash("/help me"), null);
  });
});

describe("slashCandidates — 前缀过滤", () => {
  it('裸 "/" → 全部静态命令按词表序（skill 不入场）', () => {
    const names = slashCandidates("/").map((c) => c.name);
    assert.deepEqual(
      names,
      SLASH_COMMANDS.map((c) => c.name)
    );
  });

  it("前缀过滤：/c → compact+continue；/th → thinking；/e → effort+exit", () => {
    assert.deepEqual(
      slashCandidates("/c").map((c) => c.name),
      ["compact", "continue"]
    );
    assert.deepEqual(
      slashCandidates("/th").map((c) => c.name),
      ["thinking"]
    );
    assert.deepEqual(
      slashCandidates("/e").map((c) => c.name),
      ["exit", "effort"]
    );
  });

  it("skill 混显：至少 1 字符前缀才入场；静态命令在前", () => {
    const skills = [{ name: "explore", description: "explore code" }];
    assert.deepEqual(
      slashCandidates("/", skills).map((c) => c.name),
      slashCandidates("/").map((c) => c.name)
    );
    const mixed = slashCandidates("/e", skills);
    assert.equal(mixed[0]?.kind, "command");
    assert.equal(mixed[mixed.length - 1]?.kind, "skill");
    assert.equal(mixed[mixed.length - 1]?.name, "explore");
  });

  it("首 token 之后仍按命令名前缀过滤（输入参数时菜单不消失）", () => {
    assert.deepEqual(
      slashCandidates("/thinking o").map((c) => c.name),
      ["thinking"]
    );
  });

  it("未命中 / 非 / 开头 → 空数组", () => {
    assert.deepEqual(slashCandidates("/x"), []);
    assert.deepEqual(slashCandidates("hello"), []);
    assert.deepEqual(slashCandidates(""), []);
  });

  it("候选携带 description 与 hint", () => {
    const c = slashCandidates("/comp")[0];
    assert.equal(c?.description, "压缩上下文");
    assert.equal(c?.hint, "/compact");
  });
});

describe("slashEnterAction — 菜单打开时的 Enter 裁决", () => {
  it("完整命令 → execute（带 arg）", () => {
    const act = slashEnterAction("/effort high", 0);
    assert.deepEqual(act, { kind: "execute", name: "effort", arg: "high" });
  });

  it("不完整前缀 + 选中无参命令 → accept 不带尾随空格", () => {
    const act = slashEnterAction("/comp", 0);
    assert.deepEqual(act, { kind: "accept", text: "/compact" });
  });

  it("不完整前缀 + 选中带参命令 → accept 带尾随空格（等待参数）", () => {
    const act = slashEnterAction("/th", 0);
    assert.deepEqual(act, { kind: "accept", text: "/thinking " });
  });

  it("selectedIndex 越界 → none", () => {
    assert.deepEqual(slashEnterAction("/c", 5), { kind: "none" });
    assert.deepEqual(slashEnterAction("/c", -1), { kind: "none" });
  });

  it("无参命令带多余参数 → 候选仍在，Enter 采纳纠正为无参形", () => {
    assert.deepEqual(slashEnterAction("/compact x", 0), {
      kind: "accept",
      text: "/compact",
    });
  });

  it("未知前缀（无候选）→ none", () => {
    assert.deepEqual(slashEnterAction("/zzz", 0), { kind: "none" });
  });
});

describe("slashHelpText", () => {
  it("包含全部静态命令与说明", () => {
    const text = slashHelpText();
    for (const c of SLASH_COMMANDS) {
      assert.ok(text.includes(c.hint), `must include hint ${c.hint}`);
      assert.ok(
        text.includes(c.description),
        `must include description ${c.description}`
      );
    }
  });

  it("skill 名以 /name 加载技能 行追加", () => {
    const text = slashHelpText(["explore"]);
    assert.ok(text.includes("/explore"));
    assert.ok(text.includes("加载技能"));
  });
});

describe("slashSubmitDecision — 提交裁决（非法命令不静默）", () => {
  it("合法命令 → execute（带 arg）", () => {
    assert.deepEqual(slashSubmitDecision("/thinking on"), {
      kind: "execute",
      name: "thinking",
      arg: "on",
    });
    assert.deepEqual(slashSubmitDecision("/new"), {
      kind: "execute",
      name: "new",
      arg: "",
    });
  });

  it("未知命令 → notice（UNKNOWN_SLASH_NOTICE），输入保留由 Composer 负责", () => {
    assert.deepEqual(slashSubmitDecision("/zzz"), {
      kind: "notice",
      text: UNKNOWN_SLASH_NOTICE,
    });
  });

  it("无参命令带多余参数 → notice", () => {
    assert.deepEqual(slashSubmitDecision("/compact x"), {
      kind: "notice",
      text: UNKNOWN_SLASH_NOTICE,
    });
  });

  it("非 / 开头 → send", () => {
    assert.deepEqual(slashSubmitDecision("hello"), { kind: "send" });
  });
});

describe("menuKeyEvent — 菜单打开时的键盘裁决", () => {
  const state = {
    value: "/th",
    selectedIndex: 1,
    candidates: [
      {
        kind: "command" as const,
        name: "compact" as const,
        description: "",
        hint: "/compact",
      },
      {
        kind: "command" as const,
        name: "new" as const,
        description: "",
        hint: "/new",
      },
      {
        kind: "command" as const,
        name: "help" as const,
        description: "",
        hint: "/help",
      },
    ],
  };

  it("ArrowDown → move（钳制到末项）", () => {
    assert.deepEqual(menuKeyEvent(state, "ArrowDown"), {
      kind: "move",
      index: 2,
    });
    assert.deepEqual(
      menuKeyEvent({ ...state, selectedIndex: 2 }, "ArrowDown"),
      { kind: "move", index: 2 }
    );
  });

  it("ArrowUp → move（钳制到 0）", () => {
    assert.deepEqual(menuKeyEvent(state, "ArrowUp"), {
      kind: "move",
      index: 0,
    });
    assert.deepEqual(menuKeyEvent({ ...state, selectedIndex: 0 }, "ArrowUp"), {
      kind: "move",
      index: 0,
    });
  });

  it("Escape → dismiss", () => {
    assert.deepEqual(menuKeyEvent(state, "Escape"), { kind: "dismiss" });
  });

  it("Tab → accept 高亮候选", () => {
    assert.deepEqual(menuKeyEvent(state, "Tab"), {
      kind: "accept",
      name: "new",
    });
  });

  it("Enter（非 shift）→ enter 裁决经 slashEnterAction", () => {
    // "/th" 不完整 → accept 带参命令补全形（尾随空格）；slashEnterAction
    // 按 value 重算候选（仅 thinking），索引须在其范围内。
    assert.deepEqual(menuKeyEvent({ ...state, selectedIndex: 0 }, "Enter"), {
      kind: "enter",
      action: { kind: "accept", text: "/thinking " },
    });
    // 完整命令 → execute
    assert.deepEqual(
      menuKeyEvent(
        {
          value: "/effort high",
          selectedIndex: 0,
          candidates: slashCandidates("/effort"),
        },
        "Enter"
      ),
      {
        kind: "enter",
        action: { kind: "execute", name: "effort", arg: "high" },
      }
    );
  });

  it("Shift+Enter → ignore（换行，不拦截）", () => {
    assert.deepEqual(menuKeyEvent(state, "Enter", true), { kind: "ignore" });
  });

  it("其它键 → ignore", () => {
    assert.deepEqual(menuKeyEvent(state, "a"), { kind: "ignore" });
    assert.deepEqual(menuKeyEvent(state, "Backspace"), { kind: "ignore" });
  });
});

describe("resolveArgCommand — 带参命令值域判定", () => {
  it("值域内（trim + 大小写归一）→ ok 带归一值", () => {
    assert.deepEqual(resolveArgCommand("thinking", " ON "), {
      ok: true,
      value: "on",
    });
    assert.deepEqual(resolveArgCommand("effort", "High"), {
      ok: true,
      value: "high",
    });
  });

  it("值域外 / 缺参 → usage notice（文案来自词表）", () => {
    assert.deepEqual(resolveArgCommand("thinking", ""), {
      ok: false,
      notice: "用法：/thinking on|off",
    });
    assert.deepEqual(resolveArgCommand("effort", "ultra"), {
      ok: false,
      notice: "用法：/effort low|medium|high|xhigh|max",
    });
  });

  it("词表值域与用法文案 SSOT（对齐 TUI ADJUSTABLE_EFFORT_LEVELS）", () => {
    assert.deepEqual(ARG_COMMAND_SPECS.thinking.values, ["on", "off"]);
    assert.deepEqual(ARG_COMMAND_SPECS.effort.values, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("T5 /continue slash 词表（web_slash_http_only）", () => {
  it("SLASH_COMMANDS 含 continue，hint=/continue，不进带参词表", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "continue");
    assert.ok(cmd, "/continue must be in SLASH_COMMANDS");
    assert.equal(cmd?.hint, "/continue");
    assert.equal(matchSlash("/continue")?.name, "continue");
    assert.equal(matchSlash("/CONTINUE")?.name, "continue");
    assert.deepEqual(matchSlash("/continue"), { name: "continue", arg: "" });
    assert.ok(slashHelpText().includes("/continue"));
  });

  it("带参 /continue extra → match 转发 arg（handler 发 usage EXIT；非 ARG_COMMANDS）", () => {
    // continue 不进 ARG_COMMANDS：无值域、accept 不带尾随空格。
    // matchSlash 仍转发 leftover，便于 handleCommand 发「用法：/continue」。
    assert.deepEqual(matchSlash("/continue extra"), {
      name: "continue",
      arg: "extra",
    });
    assert.deepEqual(slashSubmitDecision("/continue extra"), {
      kind: "execute",
      name: "continue",
      arg: "extra",
    });
    assert.deepEqual(slashEnterAction("/continue extra", 0), {
      kind: "execute",
      name: "continue",
      arg: "extra",
    });
  });

  it("Composer NL 续跑意图不走 slash（web_slash_http_only OUT）", () => {
    assert.deepEqual(slashSubmitDecision("please continue"), { kind: "send" });
    assert.deepEqual(slashSubmitDecision("请继续"), { kind: "send" });
    assert.deepEqual(slashSubmitDecision("keep going"), { kind: "send" });
  });
});

describe("parseSkillLoad", () => {
  const skills = [{ name: "explore", description: "x" }];

  it("精确命中 skill → name + remainder", () => {
    assert.deepEqual(parseSkillLoad("/explore extra", skills), {
      name: "explore",
      remainder: "extra",
    });
  });

  it("静态命令优先 → undefined", () => {
    assert.equal(parseSkillLoad("/help", skills), undefined);
  });

  // SC9：remainder 按 typed token 长度切，不按 canonical 名长度。
  it("裸名命中 canonical → remainder 不被 canonical 长度吃掉（SC9）", () => {
    const plugin = [
      {
        name: "arthurpower:using-agent-skills",
        aliases: ["using-agent-skills"],
      },
    ];
    assert.deepEqual(parseSkillLoad("/using-agent-skills 帮我调度", plugin), {
      name: "arthurpower:using-agent-skills",
      remainder: "帮我调度",
    });
    // canonical typed 与裸名 typed 必须收敛到同一 name + 同一 remainder。
    assert.deepEqual(
      parseSkillLoad("/arthurpower:using-agent-skills 帮我调度", plugin),
      parseSkillLoad("/using-agent-skills 帮我调度", plugin)
    );
  });

  it("remainder 为空 / 无 remainder → 空串（不切进名字里）", () => {
    const plugin = [
      {
        name: "arthurpower:using-agent-skills",
        aliases: ["using-agent-skills"],
      },
    ];
    assert.deepEqual(parseSkillLoad("/using-agent-skills", plugin), {
      name: "arthurpower:using-agent-skills",
      remainder: "",
    });
  });
});

describe("slashCandidates — 可加载技能面（含无 description，SC9）", () => {
  it("无 description 条目仍进候选，且 description 保持缺席（不补占位文案）", () => {
    const skills = [
      { name: "no-desc" },
      { name: "with-desc", description: "有描述" },
    ];
    // 前缀至少 1 字符才混入 skill（空前缀只出静态命令）。
    const out = slashCandidates("/n", skills).filter((c) => c.kind === "skill");
    assert.equal(out.length, 1);
    const noDesc = out[0];
    assert.equal(noDesc?.name, "no-desc");
    assert.equal(
      noDesc?.kind === "skill" ? noDesc.description : "sentinel",
      undefined
    );
    const withDesc = slashCandidates("/w", skills).filter(
      (c) => c.kind === "skill"
    );
    assert.equal(
      withDesc[0]?.kind === "skill" ? withDesc[0].description : "sentinel",
      "有描述"
    );
  });

  it("裸名别名参与前缀过滤，但只发一条 canonical 候选", () => {
    const skills = [{ name: "arthurpower:use", aliases: ["use"] }];
    const out = slashCandidates("/us", skills).filter(
      (c) => c.kind === "skill"
    );
    assert.deepEqual(
      out.map((c) => c.name),
      ["arthurpower:use"]
    );
  });
});
