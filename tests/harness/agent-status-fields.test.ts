// specs/agent-status-instruction-echo.md invariant 5+7 / ADR-0103:
// bidirectional-compatibility extension of the buildAgentStatusText /
// parseAgentStatusText pure-function pair — instruction and reconcile fields
// join the bar, and every scalar section precedes the `todos:` header (the
// ordering discipline is the root of bidirectional compatibility: an old
// parser reading a new bar yields a correct subset; a new parser reading an
// old bar yields legal defaults).
//
// Acceptance coverage:
//   - new-build / new-parse round-trip;
//   - a legacy bar (last_tool + todos only) parses to instruction: null, reconcile: false;
//   - unknown scalar lines before the `todos:` header are not swallowed into the todo list;
//   - malformed → null without throwing (existing contract not relaxed by the new sections);
//   - the reconcile constant is an exported artifact (referenced by tests and the roster lock);
//   - an instruction value containing `</agent_status>` does not break line-level structural parsing;
//   - a new-format bar read by the pre-extension parsing algorithm (rollback scenario)
//     yields the correct legacy subset.

import { describe, it, expect } from "vitest";

import {
  buildAgentStatusText,
  parseAgentStatusText,
  agentStatusFromMessages,
  pickPresentAgentStatusSlots,
  AGENT_STATUS_RECONCILE_LINE,
} from "../../src/harness/agent-status.ts";

// -- round-trip ---------------------------------------------------------------

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

// -- empty slots are not advertised (invariant 7) -------------------------------

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
    // Bars from old assembly points that never box the new fields (compute / TUI events) must equal the legacy shape byte-for-byte.
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

// -- field order discipline (invariant 5) ---------------------------------------

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
    // Todo lines always occupy the bar's tail section.
    expect(lines.slice(headerIdx + 1, -1)).toEqual(["- [ ] [t1] a"]);
  });
});

// -- legacy bar compatibility + hydrate -----------------------------------------

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

// -- unknown scalar lines are not swallowed into the todo section ----------------

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

// -- forward compatibility: old parsing algorithm reading a new bar --------------

describe("forward compatibility for old parsers (rollback)", () => {
  it("yields the correct legacy subset from a new-format bar", () => {
    // Replicates the pre-extension parsing algorithm: find the last_tool prefix line + take everything after the `todos:` header.
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

// -- structural substrings inside the instruction value --------------------------

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

// -- malformed bars → null without throwing --------------------------------------

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

// -- exported reconcile constant --------------------------------------------------

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

// -- inherited immutability contract for the parse result ------------------------

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

// -- conditional-slot presence projection, single source of the rule -------------

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
