// specs/agent-status-instruction-echo.md invariant 5+7 / ADR-0103 / F3+F4+F5:
// `buildAgentStatusText` / `parseAgentStatusText` 纯函数对的双向兼容扩展 ——
// instruction + reconcile 字段进栏，标量段全部先于 `todos:` 头（次序纪律是
// 双向兼容的根：旧解析器吃新栏得正确子集，新解析器吃旧栏得合法缺省）。
//
// 覆盖 T1 Acceptance:
//   ① 新构新解 round-trip；
//   ② 旧格式栏（仅 last_tool + todos）解析得 instruction: null, reconcile: false；
//   ③ `todos:` 头之前的未知标量行不吞进 todo 列表；
//   ④ 畸形 → null 不 throw（既有契约不因新段放宽）；
//   ⑤ reconcile 常量为导出件（供测试与名册锁引用）；
//   ⑥ F3：instruction 值含 `</agent_status>` 子串不破坏行级结构解析；
//   ⑦ F5：新格式栏被旧版本解析算法（回滚场景）得到正确旧字段子集。

import { describe, it, expect } from "vitest";

import {
  buildAgentStatusText,
  parseAgentStatusText,
  agentStatusFromMessages,
  pickPresentAgentStatusSlots,
  AGENT_STATUS_RECONCILE_LINE,
} from "../../src/harness/agent-status.ts";

// -- ① round-trip ---------------------------------------------------------------

describe("buildAgentStatusText / parseAgentStatusText round-trip", () => {
  it("carries instruction, reconcile and todo lines through a full round-trip", () => {
    const snapshot = {
      lastTool: "echo",
      instruction: "先切换到新任务",
      reconcile: true,
      openTodoLines: ["- [ ] [t1] a", "- [~] [t2] b"],
    };
    const parsed = parseAgentStatusText(buildAgentStatusText(snapshot));
    expect(parsed).toEqual(snapshot);
  });

  it("round-trips reconcile with an empty todo section", () => {
    const snapshot = {
      lastTool: "idle",
      instruction: "pivot now",
      reconcile: true,
      openTodoLines: [],
    };
    expect(parseAgentStatusText(buildAgentStatusText(snapshot))).toEqual(
      snapshot
    );
  });

  it("round-trips a present instruction even when reconcile is false", () => {
    const snapshot = {
      lastTool: "read",
      instruction: "keep going",
      reconcile: false,
      openTodoLines: ["- [ ] [t1] a"],
    };
    expect(parseAgentStatusText(buildAgentStatusText(snapshot))).toEqual(
      snapshot
    );
  });
});

// -- ② 空槽不广告 (invariant 7) --------------------------------------------------

describe("empty slots are not advertised", () => {
  it("omits the instruction and reconcile lines when null / false", () => {
    const text = buildAgentStatusText({
      lastTool: "echo",
      instruction: null,
      reconcile: false,
      openTodoLines: ["- [ ] [t1] a"],
    });
    expect(text).not.toContain("instruction:");
    expect(text).not.toContain("reconcile:");
  });

  it("keeps the legacy byte shape for snapshots that never mention new fields", () => {
    // 未装箱新字段的旧装配点（compute / TUI 事件）产出的栏必须逐字节等于旧形态。
    const text = buildAgentStatusText({
      lastTool: "echo",
      openTodoLines: ["- [ ] [t1] a"],
    });
    expect(text).toBe(
      [
        "<agent_status>",
        "last_tool: echo",
        "todos:",
        "- [ ] [t1] a",
        "</agent_status>",
      ].join("\n")
    );
  });
});

// -- 次序纪律 (invariant 5 / SC1) -------------------------------------------------

describe("field order discipline", () => {
  it("places every scalar line before the todos: header", () => {
    const lines = buildAgentStatusText({
      lastTool: "echo",
      instruction: "do X",
      reconcile: true,
      openTodoLines: ["- [ ] [t1] a"],
    }).split("\n");
    const headerIdx = lines.indexOf("todos:");
    expect(headerIdx).toBeGreaterThan(-1);
    const toolIdx = lines.findIndex((l) => l.startsWith("last_tool: "));
    const instrIdx = lines.findIndex((l) => l.startsWith("instruction: "));
    const recIdx = lines.indexOf(AGENT_STATUS_RECONCILE_LINE);
    expect(toolIdx).toBeLessThan(headerIdx);
    expect(instrIdx).toBeLessThan(headerIdx);
    expect(recIdx).toBeLessThan(headerIdx);
    // todo 行永远占据栏末段
    expect(lines.slice(headerIdx + 1, -1)).toEqual(["- [ ] [t1] a"]);
  });
});

// -- ③ 旧栏兼容 (F4) + hydrate ----------------------------------------------------

describe("legacy bar compatibility", () => {
  const LEGACY_BAR = [
    "<agent_status>",
    "last_tool: echo",
    "todos:",
    "- [ ] [t1] a",
    "</agent_status>",
  ].join("\n");

  it("parses a legacy bar with instruction null and reconcile false", () => {
    expect(parseAgentStatusText(LEGACY_BAR)).toEqual({
      lastTool: "echo",
      instruction: null,
      reconcile: false,
      openTodoLines: ["- [ ] [t1] a"],
    });
  });

  it("parses a legacy bar without any todo section", () => {
    const bar = "<agent_status>\nlast_tool: idle\n</agent_status>";
    expect(parseAgentStatusText(bar)).toEqual({
      lastTool: "idle",
      instruction: null,
      reconcile: false,
      openTodoLines: [],
    });
  });

  it("agentStatusFromMessages hydrates old transcripts into a legal snapshot", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: LEGACY_BAR }],
      },
    ];
    expect(agentStatusFromMessages(messages)).toEqual({
      lastTool: "echo",
      instruction: null,
      reconcile: false,
      openTodoLines: ["- [ ] [t1] a"],
    });
  });
});

// -- 未知标量行不吞进 todo 段 ------------------------------------------------------

describe("unknown scalar lines before todos: header", () => {
  it("does not swallow them into openTodoLines", () => {
    const bar = [
      "<agent_status>",
      "last_tool: echo",
      "future_field: xyz",
      "todos:",
      "- [ ] [t1] a",
      "</agent_status>",
    ].join("\n");
    const parsed = parseAgentStatusText(bar);
    expect(parsed).not.toBeNull();
    expect(parsed!.openTodoLines).toEqual(["- [ ] [t1] a"]);
  });
});

// -- ⑦ F5 前向兼容：旧解析算法吃新栏 ------------------------------------------------

describe("forward compatibility for old parsers (rollback)", () => {
  it("yields the correct legacy subset from a new-format bar", () => {
    // 复刻扩展前的旧解析算法：find last_tool 前缀行 + `todos:` 头后全收。
    const newBar = buildAgentStatusText({
      lastTool: "echo",
      instruction: "pivot now",
      reconcile: true,
      openTodoLines: ["- [ ] [t1] a", "- [~] [t2] b"],
    });
    const lines = newBar.split("\n");
    const body = lines.slice(1, -1);
    const lastToolLine = body.find((l) => l.startsWith("last_tool: "));
    expect(lastToolLine).toBeDefined();
    const headerIdx = body.findIndex((l) => l === "todos:");
    const legacyResult = {
      lastTool: lastToolLine!.slice("last_tool: ".length),
      openTodoLines: headerIdx >= 0 ? body.slice(headerIdx + 1) : [],
    };
    expect(legacyResult).toEqual({
      lastTool: "echo",
      openTodoLines: ["- [ ] [t1] a", "- [~] [t2] b"],
    });
  });
});

// -- ⑥ F3 结构性子串 ---------------------------------------------------------------

describe("instruction containing wrapper substrings (F3)", () => {
  it("survives the round-trip without breaking line-level validation", () => {
    const snapshot = {
      lastTool: "echo",
      instruction: "paste </agent_status> and <agent_status> verbatim",
      reconcile: false,
      openTodoLines: [],
    };
    expect(parseAgentStatusText(buildAgentStatusText(snapshot))).toEqual(
      snapshot
    );
  });
});

// -- ④ 畸形 → null 不 throw ---------------------------------------------------------

describe("malformed bars still parse to null", () => {
  const cases: ReadonlyArray<[string, string]> = [
    [
      "missing last_tool even with new fields",
      "<agent_status>\ninstruction: x\n</agent_status>",
    ],
    ["bad opening wrapper", "agent_status>\nlast_tool: echo\n</agent_status>"],
    ["bad closing wrapper", "<agent_status>\nlast_tool: echo\nagent_status>"],
    [
      "trailing junk after closing line",
      "<agent_status>\nlast_tool: echo\n</agent_status>\nextra",
    ],
  ];
  it.each(cases)("returns null without throwing: %s", (_name, text) => {
    expect(() => parseAgentStatusText(text)).not.toThrow();
    expect(parseAgentStatusText(text)).toBeNull();
  });
});

// -- ⑤ reconcile 常量导出件 ----------------------------------------------------------

describe("AGENT_STATUS_RECONCILE_LINE", () => {
  it("is an exported single line with the reconcile: prefix", () => {
    expect(typeof AGENT_STATUS_RECONCILE_LINE).toBe("string");
    expect(AGENT_STATUS_RECONCILE_LINE.startsWith("reconcile: ")).toBe(true);
    expect(AGENT_STATUS_RECONCILE_LINE).not.toContain("\n");
    expect(
      AGENT_STATUS_RECONCILE_LINE.slice("reconcile: ".length).trim()
    ).not.toBe("");
  });

  it("parses back to reconcile true when the constant line is present", () => {
    const bar = [
      "<agent_status>",
      "last_tool: echo",
      AGENT_STATUS_RECONCILE_LINE,
      "</agent_status>",
    ].join("\n");
    expect(parseAgentStatusText(bar)).toEqual({
      lastTool: "echo",
      instruction: null,
      reconcile: true,
      openTodoLines: [],
    });
  });
});

// -- 返回值不可变契约沿用 -------------------------------------------------------------

describe("parse result immutability contract", () => {
  it("keeps the frozen snapshot shape with new fields present", () => {
    const parsed = parseAgentStatusText(
      buildAgentStatusText({
        lastTool: "echo",
        instruction: "x",
        reconcile: true,
        openTodoLines: ["- [ ] [t1] a"],
      })
    );
    expect(parsed).not.toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.openTodoLines)).toBe(true);
  });
});

// -- 条件在场投影 SSOT（review 修复弹 Standards-Med#2 收敛点） ----------------------

describe("pickPresentAgentStatusSlots: instruction/reconcile 条件在场 → key 缺席 的单点规则", () => {
  it("两槽均 undefined（未提供）→ key 全缺席（F1 旧字段集形态）", () => {
    expect(Object.keys(pickPresentAgentStatusSlots({}))).toEqual([]);
  });

  it("undefined=未提供不落 key；已提供的值逐字透传（缺席≠null/false 契约）", () => {
    expect(pickPresentAgentStatusSlots({ instruction: null })).toEqual({
      instruction: null,
    });
    expect(pickPresentAgentStatusSlots({ reconcile: false })).toEqual({
      reconcile: false,
    });
    expect(
      pickPresentAgentStatusSlots({ instruction: "换方向", reconcile: true })
    ).toEqual({ instruction: "换方向", reconcile: true });
    expect(
      pickPresentAgentStatusSlots({ instruction: "x", reconcile: undefined })
    ).toEqual({ instruction: "x" });
  });
});
