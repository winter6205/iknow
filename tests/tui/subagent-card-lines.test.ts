/**
 * tests/tui/subagent-card-lines.test.ts
 *
 * Pure-function unit tests for the spawn card's two-line projection (no
 * OpenTUI / no React; imports the pure module directly) — SC2–SC5, the
 * no-`title` fallback and the one-line visual clip of
 * specs/subagent-card-title.md.
 *
 * Invariant: line 1 is the operator `title` carried on that worker's spawn
 * record (`SubagentInfo.title`), identical while live and once completed; line
 * 2 is one activity slot — the joined worker's most recently issued tool
 * **name plus its argument summary** (`toolName · summary`, the shared
 * `formatToolStatusLine` wording) while live, the literal `✓ Done` once
 * completed, nothing when failed (that card's failure
 * overlay owns it). The card is exactly two lines in every state: `taskPreview`
 * left the card (it stays on `SubagentInfo` / `SubagentPanel`).
 *
 * Slot wording is never the card's own invention: it comes from the shared
 * tool-summary formatter, so the transcript's tool lines and this slot cannot
 * drift. `status: "ok"` there is a neutral name-and-summary assembly, not a
 * success claim (see the T2 describe below).
 *
 * Join key = `SubagentInfo.toolUseId`; a missing join key produces no card and
 * never borrows another worker's title or tool name.
 *
 * Line 1 has two carriers of the same title: the live worker's spawn record,
 * and — for a reloaded session with no worker list — the settled block's own
 * tool input (`settledSpawnCardFromBlock`), whose line 2 stays blank.
 */
import { describe, expect, test } from "bun:test";
import {
  IDENTITY_FALLBACK_ROLE,
  isLiveSubagent,
  projectSubagentCardLines,
  settledSpawnCardFromBlock,
  subagentCardLinesMap,
  subagentCardsKey,
} from "../../src/tui/subagent-message-lines.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type {
  SubagentActivity,
  SubagentInfo,
} from "../../src/harness/subagent/manager.js";

const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-card-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    toolUseId: `toolu_${fixtureCounter}`,
    ...overrides,
  };
}

describe("projectSubagentCardLines — join 键的 EXIT 面（不借别的 worker）", () => {
  test("empty: subagents=[] → null", () => {
    expect(projectSubagentCardLines([], "toolu_1", 80)).toBeNull();
  });

  test("toolUseId 缺省 / 空串 / 纯空白 → null", () => {
    const subs = [makeSubagent({ toolUseId: undefined })];
    expect(projectSubagentCardLines(subs, undefined, 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "", 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "   ", 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "\t\n", 80)).toBeNull();
  });

  test("匹配不到该 toolUseId → null（不选第一个凑数）", () => {
    const subs = [
      makeSubagent({ toolUseId: "toolu_a" }),
      makeSubagent({ toolUseId: "toolu_b" }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_missing", 80)).toBeNull();
  });

  test("匹配到 failed → null（SC5：归该卡 failure overlay）", () => {
    const subs = [
      makeSubagent({
        state: "failed",
        toolUseId: "toolu_x",
        endedAt: iso(-500),
        reason: "crashed",
      }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_x", 80)).toBeNull();
  });

  test("同键上 failed 排在 live 之前 → failed 整条跳过、不为键占位，live 条目胜出", () => {
    const subs = [
      makeSubagent({
        state: "failed",
        toolUseId: "toolu_x",
        endedAt: iso(-500),
      }),
      makeSubagent({ state: "running", toolUseId: "toolu_x", role: "explore" }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_x", 80)).toEqual({
      titleLine: "explore",
      detailLine: "",
      done: false,
    });
  });
});

describe("SC2 — live 卡：第 1 行 title，第 2 行最近发出的工具名 · 摘要", () => {
  test("starting / running 都是 live：title + 工具名 · 摘要，done=false，且只有两行", () => {
    for (const state of ["starting", "running"] as const) {
      const info = makeSubagent({
        state,
        role: "explore",
        toolUseId: "toolu_live",
        title: "查文档",
        activity: { toolName: "read_file", toolInput: {} },
      });
      const card = projectSubagentCardLines([info], "toolu_live", 80);
      // Original regression fingerprint (kept): line 2 is THIS worker's own
      // issued call, never another worker's, and the card is exactly two lines.
      // Re-pinned for T2: the slot is `toolName · 摘要`, so a registered tool
      // whose input carries no `path` shows the registry's own "?" fallback
      // instead of the bare name T1 asserted.
      expect(card).toEqual({
        titleLine: "查文档",
        detailLine: "read_file · Read ?",
        done: false,
      });
      // The card is exactly two lines: no third (done) line exists while live.
      expect(Object.keys(card!).sort()).toEqual([
        "detailLine",
        "done",
        "titleLine",
      ]);
    }
  });

  test("taskPreview 不再上卡（SC2：两行里都没有任务正文）", () => {
    const info = makeSubagent({
      toolUseId: "toolu_prev",
      title: "跑测试",
      taskPreview: "这是一段很长的任务正文，不该出现在卡上",
      activity: { toolName: "bash", toolInput: {} },
    });
    const card = projectSubagentCardLines([info], "toolu_prev", 80)!;
    expect(card.titleLine).toBe("跑测试");
    expect(card.detailLine).toBe("bash");
    expect(card.titleLine + card.detailLine).not.toContain("任务正文");
  });

  test("无活动读数（字段缺席或 null）→ 第 2 行空占位，卡仍是两行", () => {
    const absent = projectSubagentCardLines(
      [makeSubagent({ toolUseId: "toolu_no", title: "等待中" })],
      "toolu_no",
      80
    )!;
    expect(absent).toEqual({
      titleLine: "等待中",
      detailLine: "",
      done: false,
    });
    const empty = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_em",
          title: "等待中",
          activity: null,
        }),
      ],
      "toolu_em",
      80
    )!;
    expect(empty.detailLine).toBe("");
    expect(typeof empty.titleLine).toBe("string");
  });

  test("第 1 行不带 running 后缀（任何状态都不追加进度文案）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_sfx",
          title: "查引用",
          activity: { toolName: "grep", toolInput: {} },
        }),
      ],
      "toolu_sfx",
      80
    )!;
    expect(card.titleLine).toBe("查引用");
    expect(card.titleLine).not.toContain("running");
  });
});

describe("SC3 — completed 卡：同一行 1，槽位换成 `✓ Done`", () => {
  test("第 1 行与 live 逐字相同；第 2 行 = `✓ Done`；工具名不留存", () => {
    const subs = [
      makeSubagent({
        state: "completed",
        toolUseId: "toolu_done",
        title: "查文档",
        endedAt: iso(100),
        summary: "收尾摘要",
      }),
    ];
    const card = projectSubagentCardLines(subs, "toolu_done", 80)!;
    expect(card).toEqual({
      titleLine: "查文档",
      detailLine: "✓ Done",
      done: true,
    });
  });

  test("终态即使带着陈旧活动名也只画 `✓ Done`（槽位不并存）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          toolUseId: "toolu_stale",
          endedAt: iso(100),
          activity: { toolName: "read_file", toolInput: {} },
        }),
      ],
      "toolu_stale",
      80
    )!;
    expect(card.detailLine).toBe("✓ Done");
    expect(card.detailLine).not.toContain("read_file");
  });

  test("completed 与 live 的第 1 行同源同值（同一 spawn record title）", () => {
    const live = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_same",
          role: "explore",
          title: "重构卡片",
        }),
      ],
      "toolu_same",
      80
    )!;
    const done = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          toolUseId: "toolu_same",
          role: "explore",
          title: "重构卡片",
          endedAt: iso(1),
        }),
      ],
      "toolu_same",
      80
    )!;
    expect(done.titleLine).toBe(live.titleLine);
  });
});

describe("SC4 — 两个并发 worker：标题与活动名各自独立，永不串行", () => {
  test("两张卡只吃自己 join 的那条活动名与自己 spawn record 的 title", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_A",
        role: "explore",
        title: "找调用点",
        activity: { toolName: "grep", toolInput: {} },
      }),
      makeSubagent({
        toolUseId: "toolu_B",
        role: "general-purpose",
        title: "跑测试",
        activity: { toolName: "bash", toolInput: {} },
      }),
    ];
    const cardA = projectSubagentCardLines(subs, "toolu_A", 80)!;
    const cardB = projectSubagentCardLines(subs, "toolu_B", 80)!;
    expect(cardA.titleLine).toBe("找调用点");
    expect(cardB.titleLine).toBe("跑测试");
    // Re-pinned for T2 (original fingerprint kept: each card shows only its own
    // worker's issued call, never the other's): `grep` is registered, so its
    // missing `pattern` falls back to the registry's "?" instead of a bare name.
    expect(cardA.detailLine).toBe("grep · Search ?");
    expect(cardB.detailLine).toBe("bash");
    // Crossed text must not appear on either card.
    expect(cardA.titleLine + cardA.detailLine).not.toContain("跑测试");
    expect(cardA.detailLine).not.toBe("bash");
    expect(cardB.titleLine + cardB.detailLine).not.toContain("找调用点");
    expect(cardB.detailLine).not.toBe("grep");
  });

  test("一张卡有 title、另一张没有 → 有 title 的绝不把自己的标题借给对方", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_A",
        role: "explore",
        title: "只属于 A",
      }),
      makeSubagent({ toolUseId: "toolu_B", role: "general-purpose" }),
    ];
    const cardA = projectSubagentCardLines(subs, "toolu_A", 80)!;
    const cardB = projectSubagentCardLines(subs, "toolu_B", 80)!;
    expect(cardA.titleLine).toBe("只属于 A");
    expect(cardB.titleLine).toBe("general-purpose");
  });
});

// ============================================================================
// T2 — 第 2 行的槽位文字：`toolName · 参数摘要`，措辞取自共享 formatter
// (src/shared/tool-line.ts / formatToolStatusLine, status "ok")。卡上不另写
// 模板，未知工具回落裸名，槽位恒为一行。
// ============================================================================

/** Every slot below is read through the single public projection, so the same
 *  literals are what both hosts (live tail / history) render. */
function slotOf(
  activity: SubagentActivity,
  cols = 80,
  state: SubagentInfo["state"] = "running"
): string {
  const card = projectSubagentCardLines(
    [makeSubagent({ toolUseId: "toolu_slot", state, activity })],
    "toolu_slot",
    cols
  )!;
  return card.detailLine;
}

describe("T2 槽位 — 已注册工具拼出 `toolName · 参数摘要`", () => {
  // cols=80 keeps these fixtures inside the shared formatter's own detail budget
  // (CHROME_RESERVE=12 leaves ≥ 59 columns), so the literals below are the
  // formatter's bytes with no width clipping applied.
  test("读 / 搜 / shell / 写 / 改：摘要逐字取自注册表，槽位不再是裸工具名", () => {
    const cases: ReadonlyArray<readonly [SubagentActivity, string]> = [
      [
        { toolName: "read_file", toolInput: { path: "src/a.ts" } },
        "read_file · Read src/a.ts",
      ],
      [
        { toolName: "grep", toolInput: { pattern: "foo" } },
        "grep · Search foo",
      ],
      [{ toolName: "bash", toolInput: { command: "ls -la" } }, "bash · ls -la"],
      [
        {
          toolName: "write_file",
          toolInput: { path: "p.ts", content: "a\nb" },
        },
        "write_file · Wrote p.ts (2 lines)",
      ],
      [
        {
          toolName: "edit_file",
          toolInput: { path: "a.ts", old_str: "x", new_str: "y\nz" },
        },
        "edit_file · Edited a.ts (1 → 2 lines)",
      ],
    ];
    for (const [activity, expected] of cases) {
      const slot = slotOf(activity);
      expect(slot).toBe(expected);
      // Both halves of the contract at once: the summary really arrived (T1 drew
      // the bare name only), and the card did not invent its own wording — it
      // stays `<registry name> · <registry detail>`.
      expect(slot).not.toBe(activity.toolName);
      expect(slot.startsWith(`${activity.toolName} · `)).toBe(true);
    }
  });

  test("入参字段缺席 → 注册表自身的 `?` 兜底照样拼进槽位", () => {
    expect(slotOf({ toolName: "read_file", toolInput: {} })).toBe(
      "read_file · Read ?"
    );
  });

  test("摘要为空 → 裸工具名，不留悬空分隔符（`bash` 无 command）", () => {
    const slot = slotOf({ toolName: "bash", toolInput: {} });
    expect(slot).toBe("bash");
    expect(slot.includes("·")).toBe(false);
  });

  test("CJK 摘要按视觉宽度保留（宽列下逐字，不预先截半）", () => {
    expect(
      slotOf({
        toolName: "read_file",
        toolInput: { path: "查找文档并整理结果.ts" },
      })
    ).toBe("read_file · Read 查找文档并整理结果.ts");
  });

  test("两张卡的入参不同 → 各画各的摘要（同名工具也不串摘要）", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_IA",
        title: "甲",
        activity: { toolName: "read_file", toolInput: { path: "a.ts" } },
      }),
      makeSubagent({
        toolUseId: "toolu_IB",
        title: "乙",
        activity: { toolName: "read_file", toolInput: { path: "b.ts" } },
      }),
    ];
    const cardA = projectSubagentCardLines(subs, "toolu_IA", 80)!;
    const cardB = projectSubagentCardLines(subs, "toolu_IB", 80)!;
    expect(cardA.detailLine).toBe("read_file · Read a.ts");
    expect(cardB.detailLine).toBe("read_file · Read b.ts");
    expect(cardA.detailLine).not.toBe(cardB.detailLine);
    // The recorded input is per-worker data: B's path must not appear on A.
    expect(cardA.detailLine.includes("b.ts")).toBe(false);
    expect(cardB.detailLine.includes("a.ts")).toBe(false);
  });
});

describe("T2 槽位 — 未注册工具名回落裸名（永不出现原始 JSON）", () => {
  test("mcp 命名空间名 + 结构化入参 → 槽位就是那个名字", () => {
    expect(
      slotOf({
        toolName: "mcp__serena__find_symbol",
        toolInput: { symbol_name: "X", relation: "children" },
      })
    ).toBe("mcp__serena__find_symbol");
  });

  test("`Bash`（大写）≠ 已注册的 `bash` → 裸名；共享 formatter 的 `(name)` 占位符不拼接", () => {
    // The registry key is lowercase/snake/kebab. Joining the shared formatter's
    // unknown-tool placeholder would print `Bash · (Bash)` — the slot stays the
    // bare name instead.
    const slot = slotOf({ toolName: "Bash", toolInput: { command: "ls" } });
    expect(slot).toBe("Bash");
    expect(slot.includes("(")).toBe(false);
    expect(slot.includes("·")).toBe(false);
  });

  test("入参的字段名 / 嵌套结构 / 引号都不进槽位", () => {
    const slot = slotOf({
      toolName: "unknown_tool",
      toolInput: { secret_path: "/tmp/whatever", nested: { a: 1 } },
    });
    expect(slot).toBe("unknown_tool");
    for (const leak of ["secret_path", "nested", "{", '"', "1"]) {
      expect(slot.includes(leak)).toBe(false);
    }
  });
});

describe("T2 槽位 — 两个子代理工具继承共享 formatter 自己声明的形状", () => {
  // Deliberate inheritance, not an accidental pass: `formatToolStatusLine`
  // returns **detail only** for spawn_subagent / subagent_result (the glyph and
  // identity live on line 1 / SubagentPanel), so a worker whose most recently
  // issued call was one of these shows that detail — never `name · detail`.
  test("spawn_subagent → 槽位是角色名，不带 `spawn_subagent · ` 前缀", () => {
    const slot = slotOf({
      toolName: "spawn_subagent",
      toolInput: { subagent_type: "explore", task: "t", title: "x" },
    });
    expect(slot).toBe("explore");
    expect(slot.includes("spawn_subagent")).toBe(false);
    // status "ok" is what keeps this a role, not a progress claim.
    expect(slot.includes("running")).toBe(false);
  });

  test("subagent_result → 槽位是 `Poll <task_id>`", () => {
    expect(
      slotOf({ toolName: "subagent_result", toolInput: { task_id: "abc" } })
    ).toBe("Poll abc");
  });

  test("spawn 无 subagent_type → 沿用与第 1 行同源的 catalog 兜底角色", () => {
    expect(slotOf({ toolName: "spawn_subagent", toolInput: {} })).toBe(
      IDENTITY_FALLBACK_ROLE
    );
  });
});

describe("T2 槽位 — status `ok` 只是中性「名 + 摘要」，不表示成功", () => {
  test("同一 name+input：调用在途与已结算 → 槽位逐字相同（槽位读不出结算）", () => {
    // T1's retention is why these two are indistinguishable: the projected value
    // carries no "settled" field at all, so a call whose `tool_result` landed and
    // one still waiting for it reach the card as the same bytes. The past-tense
    // wording ("Wrote") therefore names the REQUESTED operation.
    const issued: SubagentActivity = {
      toolName: "write_file",
      toolInput: { path: "p.ts", content: "a\nb" },
    };
    const settledSameCall: SubagentActivity = {
      toolName: "write_file",
      toolInput: { path: "p.ts", content: "a\nb" },
    };
    const whileIssued = slotOf(issued, 80, "starting");
    const whileSettled = slotOf(settledSameCall, 80, "running");
    expect(whileIssued).toBe("write_file · Wrote p.ts (2 lines)");
    expect(whileSettled).toBe(whileIssued);
  });

  test("槽位永不含成功 / 失败断言词（那两个信号归 `✓ Done` 与 failure overlay）", () => {
    const activities: ReadonlyArray<SubagentActivity> = [
      { toolName: "write_file", toolInput: { path: "p.ts", content: "a\nb" } },
      {
        toolName: "edit_file",
        toolInput: { path: "p.ts", old_str: "a", new_str: "b" },
      },
      { toolName: "bash", toolInput: { command: "ls -la" } },
      { toolName: "spawn_subagent", toolInput: { subagent_type: "explore" } },
      { toolName: "subagent_result", toolInput: { task_id: "abc" } },
    ];
    for (const activity of activities) {
      const slot = slotOf(activity);
      expect(slot.includes("✓")).toBe(false);
      expect(slot.includes("Done")).toBe(false);
      expect(slot.includes("[失败]")).toBe(false);
      expect(slot.toLowerCase().includes("fail")).toBe(false);
    }
  });
});

describe("T2 槽位 — 生命周期照旧（空槽 / completed / failed 都不被摘要改动）", () => {
  test("completed 丢弃整份活动值：带输入的完整调用也不与 `✓ Done` 并存", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          toolUseId: "toolu_done_sum",
          title: "写文件",
          endedAt: iso(100),
          activity: {
            toolName: "write_file",
            toolInput: { path: "p.ts", content: "a\nb" },
          },
        }),
      ],
      "toolu_done_sum",
      80
    )!;
    expect(card.detailLine).toBe("✓ Done");
    expect(card.detailLine.includes("Wrote")).toBe(false);
    expect(card.detailLine.includes("write_file")).toBe(false);
    expect(card.done).toBe(true);
  });

  test("failed 带着完整活动值仍不出卡（map 也不为该键占位）", () => {
    const subs = [
      makeSubagent({
        state: "failed",
        toolUseId: "toolu_f_sum",
        endedAt: iso(-500),
        reason: "crashed",
        activity: { toolName: "read_file", toolInput: { path: "src/a.ts" } },
      }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_f_sum", 80)).toBeNull();
    expect(subagentCardLinesMap(subs, 80).size).toBe(0);
  });

  test("activity 缺席 / null → 空槽仍是空串，卡仍是两行（摘要层不得编造文字）", () => {
    const absent = projectSubagentCardLines(
      [makeSubagent({ toolUseId: "toolu_absent_sum", title: "等待中" })],
      "toolu_absent_sum",
      80
    )!;
    const nullish = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_null_sum",
          title: "等待中",
          activity: null,
        }),
      ],
      "toolu_null_sum",
      80
    )!;
    for (const card of [absent, nullish]) {
      expect(card.detailLine).toBe("");
      expect(Object.keys(card).sort()).toEqual([
        "detailLine",
        "done",
        "titleLine",
      ]);
    }
  });

  test("历史卡（settled block 无 live worker）第 2 行仍是空槽：摘要只属于 live", () => {
    const card = settledSpawnCardFromBlock({
      name: "spawn_subagent",
      input: { subagent_type: "explore", task: "t", title: "整理报告" },
      settled: true,
      cols: 80,
    })!;
    expect(card.titleLine).toBe("整理报告");
    expect(card.detailLine).toBe("");
  });
});

describe("T2 槽位 — 恒为一行：按 cols 视觉宽度收口", () => {
  const wideActivities: ReadonlyArray<SubagentActivity> = [
    {
      toolName: "read_file",
      toolInput: { path: `${"deep/".repeat(40)}index.ts` },
    },
    {
      toolName: "bash",
      toolInput: {
        command: 'find . -name "*.tsx" -exec grep -l placeholder {} ;'.repeat(
          4
        ),
      },
    },
    {
      toolName: "grep",
      toolInput: {
        pattern: "查找中文模式串并且很长的一段描述性文字用于压窄列宽",
      },
    },
    {
      toolName: "mcp__serena__find_symbol",
      toolInput: { symbol_name: "X".repeat(120) },
    },
  ];

  test("长摘要 / CJK 摘要 / 超长未注册名：任意 cols 下 ≤ max(1, cols) 且无换行", () => {
    // `clipDetail` reserves CHROME_RESERVE=12 columns, so at narrow widths the
    // assembled `name · detail` is longer than the budget before the card clips
    // it — pin the one-line property, not an exact string.
    for (const activity of wideActivities) {
      for (const cols of [1, 4, 8, 12, 20, 30, 40, 60, 80, 120]) {
        const slot = slotOf(activity, cols);
        expect(slot.includes("\n")).toBe(false);
        expect(visualWidth(slot)).toBeLessThanOrEqual(Math.max(1, cols));
      }
    }
  });

  test("入参里的换行 / 制表符压成一行（第 2 行不把两行的卡撑成三行）", () => {
    const slot = slotOf(
      {
        toolName: "grep",
        toolInput: { pattern: "第一行\n第二行\t制表" },
      },
      80
    );
    expect(slot).toBe("grep · Search 第一行 第二行 制表");
    expect(slot.includes("\n")).toBe(false);
    expect(slot.includes("\t")).toBe(false);
    expect(visualWidth(slot)).toBeLessThanOrEqual(80);
  });

  test("窄 cols 下第 1 行不受摘要牵连（两行各自收口）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_narrow",
          title: "整理报告",
          activity: {
            toolName: "read_file",
            toolInput: { path: `${"deep/".repeat(40)}index.ts` },
          },
        }),
      ],
      "toolu_narrow",
      12
    )!;
    expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(12);
    expect(visualWidth(card.detailLine)).toBeLessThanOrEqual(12);
    expect(card.titleLine.includes("read_file")).toBe(false);
    expect(card.detailLine.includes("整理报告")).toBe(false);
  });
});

describe("no-title fallback — 回落到 catalog 角色（spec「Does」的 fallback 条）", () => {
  test("title 缺席 → 用该 worker 自己的 catalog role；缺 role → fallback 常量", () => {
    const withRole = projectSubagentCardLines(
      [makeSubagent({ toolUseId: "toolu_r", role: "explore" })],
      "toolu_r",
      80
    )!;
    expect(withRole.titleLine).toBe("explore");
    const noRole = projectSubagentCardLines(
      [makeSubagent({ toolUseId: "toolu_nr", role: undefined })],
      "toolu_nr",
      80
    )!;
    expect(noRole.titleLine).toBe(IDENTITY_FALLBACK_ROLE);
  });

  test("空白 role 也走 fallback 常量（trim 后为空即无身份）", () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ toolUseId: "toolu_wb", role: " \t " })],
      "toolu_wb",
      80
    )!;
    expect(card.titleLine).toBe(IDENTITY_FALLBACK_ROLE);
  });

  test("钉死约束：任何输入组合都不输出「子代理」字面值", () => {
    for (const patch of [
      {},
      { role: "" },
      { role: "   " },
      { title: undefined },
      { title: "真实标题", role: "   " },
    ] as ReadonlyArray<Partial<SubagentInfo>>) {
      const card = projectSubagentCardLines(
        [makeSubagent({ toolUseId: "toolu_cn", ...patch })],
        "toolu_cn",
        80
      )!;
      expect(card.titleLine).not.toContain("子代理");
    }
  });
});

describe("overflow — 两行各按 cols 视觉宽度收口，永不换行", () => {
  test("超长 title + 超长工具名 + cols=20 → 两行 ≤ 20 且无换行", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_o",
          title: "a".repeat(100),
          activity: { toolName: "b".repeat(100), toolInput: {} },
        }),
      ],
      "toolu_o",
      20
    )!;
    expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(20);
    expect(visualWidth(card.detailLine)).toBeLessThanOrEqual(20);
    expect(card.titleLine.includes("\n")).toBe(false);
    expect(card.detailLine.includes("\n")).toBe(false);
  });

  test("CJK title + 窄列 → 按视觉宽度（CJK 占 2 列）截断", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          toolUseId: "toolu_cjk",
          title: "查找文档并且继续往下列出更多内容",
        }),
      ],
      "toolu_cjk",
      12
    )!;
    expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(12);
  });

  test("cols <= 0 → 1 列预算（不返回未截断原串）", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_zero",
        title: "读文件",
        activity: { toolName: "read_file", toolInput: {} },
      }),
    ];
    for (const cols of [0, -1, -80]) {
      const card = projectSubagentCardLines(subs, "toolu_zero", cols)!;
      expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(1);
      expect(visualWidth(card.detailLine)).toBeLessThanOrEqual(1);
    }
  });

  test("`✓ Done` 逐字优先于列宽（固定字面量，宿主 wrapMode 裁边）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          toolUseId: "toolu_done_clip",
          title: "标题",
          endedAt: iso(1),
        }),
      ],
      "toolu_done_clip",
      1
    )!;
    expect(card.detailLine).toBe("✓ Done");
    expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(1);
  });
});

describe("subagentCardLinesMap — 逐卡 map（key = toolUseId）", () => {
  test("empty：[] → 空 map", () => {
    const map = subagentCardLinesMap([], 80);
    expect(map.size).toBe(0);
    expect(map.get("toolu_any")).toBeUndefined();
  });

  test("live + completed 都入 map，各自两行", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_live",
          state: "running",
          title: "进行中",
          activity: { toolName: "grep", toolInput: {} },
        }),
        makeSubagent({
          toolUseId: "toolu_done",
          state: "completed",
          title: "已完成",
          endedAt: iso(-100),
        }),
      ],
      80
    );
    expect(map.size).toBe(2);
    // Re-pinned for T2 (fingerprint kept: both live and completed enter the
    // map, each with exactly its own two lines): `grep` is registered, so the
    // absent `pattern` shows the registry's "?" summary.
    expect(map.get("toolu_live")).toEqual({
      titleLine: "进行中",
      detailLine: "grep · Search ?",
      done: false,
    });
    expect(map.get("toolu_done")).toEqual({
      titleLine: "已完成",
      detailLine: "✓ Done",
      done: true,
    });
  });

  test("缺 toolUseId / 空串 toolUseId 的条目整体跳过", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({ toolUseId: undefined }),
        makeSubagent({ toolUseId: "" }),
        makeSubagent({ toolUseId: "toolu_has" }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.has("toolu_has")).toBe(true);
  });

  test("failed 条目整体跳过（SC5）", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          state: "failed",
          toolUseId: "toolu_failed",
          endedAt: iso(-500),
        }),
        makeSubagent({ state: "running", toolUseId: "toolu_ok" }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.has("toolu_failed")).toBe(false);
    expect(map.has("toolu_ok")).toBe(true);
  });

  test("重复 toolUseId → 列表序首个合格条目胜，后来者不覆写", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_dup",
          role: "explore",
          activity: { toolName: "grep", toolInput: {} },
        }),
        makeSubagent({
          toolUseId: "toolu_dup",
          role: "general-purpose",
          activity: { toolName: "bash", toolInput: {} },
        }),
      ],
      80
    );
    expect(map.size).toBe(1);
    // Re-pinned for T2 (fingerprint kept: the FIRST eligible entry wins, so the
    // loser's `bash` never reaches the slot): the winner is a registered `grep`
    // whose absent `pattern` shows the registry's "?" summary.
    expect(map.get("toolu_dup")).toEqual({
      titleLine: "explore",
      detailLine: "grep · Search ?",
      done: false,
    });
  });

  test("与 projectSubagentCardLines 同源：map 取出的卡 = 单卡投影", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_src",
        title: "同源",
        activity: { toolName: "read_file", toolInput: {} },
      }),
    ];
    const projected = projectSubagentCardLines(subs, "toolu_src", 30);
    // Guard, not a cast: the single-card projection returns `null` on a miss
    // while Map#get returns `undefined`, so the pair must be pinned explicitly
    // before the two shapes can be compared.
    if (projected === null)
      throw new Error("expected a projected card line pair");
    expect(subagentCardLinesMap(subs, 30).get("toolu_src")).toEqual(projected);
  });

  test("exception：非法 startedAt / 缺终态字段不影响判定", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_iso2",
          state: "completed",
          startedAt: "not-a-date",
          endedAt: "not-a-date",
          summary: undefined,
        }),
      ],
      80
    );
    expect(map.get("toolu_iso2")).toEqual({
      titleLine: IDENTITY_FALLBACK_ROLE,
      detailLine: "✓ Done",
      done: true,
    });
  });

  test("纯函数：同输入两次投影 deepEqual", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_p1",
        title: "一",
        activity: { toolName: "grep", toolInput: {} },
      }),
      makeSubagent({
        toolUseId: "toolu_p2",
        title: "二",
        state: "completed",
        endedAt: iso(1),
      }),
    ];
    expect(subagentCardLinesMap(subs, 80)).toEqual(
      subagentCardLinesMap(subs, 80)
    );
  });
});

describe("isLiveSubagent — 判据不变（面板 / Ctrl+X 分派同源）", () => {
  test("starting / running 为 live；completed / failed 不是", () => {
    expect(isLiveSubagent(makeSubagent({ state: "starting" }))).toBe(true);
    expect(isLiveSubagent(makeSubagent({ state: "running" }))).toBe(true);
    expect(isLiveSubagent(makeSubagent({ state: "completed" }))).toBe(false);
    expect(isLiveSubagent(makeSubagent({ state: "failed" }))).toBe(false);
  });
});

describe("subagentCardsKey — useMemo 依赖签名（1Hz 轮询要真的重绘）", () => {
  test("同内容不同数组引用 → 同签名（轮询每次 setSubagents 新数组不得让下游重投影）", () => {
    const a = [makeSubagent({ toolUseId: "toolu_k1" })];
    const b = [...a];
    expect(b).not.toBe(a);
    expect(subagentCardsKey(b)).toBe(subagentCardsKey(a));
  });

  test("投影读取的字段任一变化 → 签名变化（漏一字段 = 缓存返回过期卡片）", () => {
    const base = [
      makeSubagent({
        toolUseId: "toolu_k2",
        role: "explore",
        title: "甲",
        activity: { toolName: "grep", toolInput: {} },
      }),
    ];
    const fields: ReadonlyArray<Partial<SubagentInfo>> = [
      { toolUseId: "toolu_k2_other" },
      { state: "completed" },
      { role: "general-purpose" },
      { title: "乙" },
      { activity: { toolName: "bash", toolInput: {} } },
    ];
    for (const patch of fields) {
      expect(
        subagentCardsKey([makeSubagent({ ...base[0]!, ...patch })])
      ).not.toBe(subagentCardsKey(base));
    }
  });

  test("缺席 / null 都是空槽（不强制重绘），真实活动对象必须换签名", () => {
    // Retired distinction: the old absent-vs-"" split existed because "" meant
    // "read completed, nothing waiting" while absent meant "no read yet". Under
    // retention both render one identical empty slot, so repainting between
    // them would rebuild the element tree for nothing. What must repaint is the
    // arrival of a real activity object.
    const pending = [makeSubagent({ toolUseId: "toolu_k5" })];
    const nothingIssued = [
      makeSubagent({ toolUseId: "toolu_k5", activity: null }),
    ];
    const issued = [
      makeSubagent({
        toolUseId: "toolu_k5",
        activity: { toolName: "bash", toolInput: {} },
      }),
    ];
    expect(subagentCardsKey(issued)).not.toBe(subagentCardsKey(pending));
    expect(subagentCardsKey(issued)).not.toBe(subagentCardsKey(nothingIssued));
  });

  test("T2：toolName 不变、toolInput 变化 → 签名必须变（否则摘要被冻住）", () => {
    // The slot now renders the recorded input, so a signature that only moved
    // with the tool name would keep serving the previous summary: the 1 Hz poll
    // replaces the activity value with an equal-named call and the memo would
    // consider the card unchanged. The whole activity object is serialized, so
    // any input difference — flat or nested — is a new signature.
    const first = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: { toolName: "read_file", toolInput: { path: "a.ts" } },
      }),
    ];
    const sameNameNewPath = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: { toolName: "read_file", toolInput: { path: "b.ts" } },
      }),
    ];
    const nestedChanged = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: {
          toolName: "read_file",
          toolInput: { path: "a.ts", range: { start: 2 } },
        },
      }),
    ];
    const emptyInput = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: { toolName: "read_file", toolInput: {} },
      }),
    ];
    expect(subagentCardsKey(sameNameNewPath)).not.toBe(subagentCardsKey(first));
    expect(subagentCardsKey(nestedChanged)).not.toBe(subagentCardsKey(first));
    expect(subagentCardsKey(emptyInput)).not.toBe(subagentCardsKey(first));
    // The stale signature would really have been stale: the two cards differ.
    expect(
      subagentCardLinesMap(sameNameNewPath, 80).get("toolu_kin")!.detailLine
    ).not.toBe(subagentCardLinesMap(first, 80).get("toolu_kin")!.detailLine);
    // Deep-equal input written in a different key order is the same call: the
    // signature is order-sensitive (JSON.stringify), so that case costs at most
    // one extra repaint — what must not happen is any visible text drift.
    const reordered = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: {
          toolName: "edit_file",
          toolInput: { path: "a.ts", old_str: "x" },
        },
      }),
    ];
    const reorderedOther = [
      makeSubagent({
        toolUseId: "toolu_kin",
        activity: {
          toolName: "edit_file",
          toolInput: { old_str: "x", path: "a.ts" },
        },
      }),
    ];
    expect(
      subagentCardLinesMap(reordered, 80).get("toolu_kin")!.detailLine
    ).toBe(
      subagentCardLinesMap(reorderedOther, 80).get("toolu_kin")!.detailLine
    );
  });

  test("taskPreview 不在签名里：卡不再读它，面板另有数据源（不留无消费者的失效面）", () => {
    const a = [makeSubagent({ toolUseId: "toolu_k6", taskPreview: "甲" })];
    const b = [makeSubagent({ toolUseId: "toolu_k6", taskPreview: "乙" })];
    expect(subagentCardsKey(a)).toBe(subagentCardsKey(b));
  });

  test("空数组 / 顺序敏感：签名是纯函数（同入参两次调用逐字相等）", () => {
    expect(subagentCardsKey([])).toBe("[]");
    const two = [
      makeSubagent({ toolUseId: "toolu_k3" }),
      makeSubagent({ toolUseId: "toolu_k4" }),
    ];
    const flipped = [two[1]!, two[0]!];
    expect(subagentCardsKey(two)).toBe(subagentCardsKey(two));
    expect(subagentCardsKey(flipped)).not.toBe(subagentCardsKey(two));
  });

  test("单射：分隔符 / 引号 / 反斜杠注入不撞签名（手拼分隔符会撞的那组）", () => {
    // role (the `subagent_type` argument) and the activity tool name are
    // arbitrary strings. If the signature were joined with a literal separator,
    // the two **different** tuples below would serialize to one string → the
    // memo would return the previous worker's card. JSON escaping makes field
    // boundaries unforgeable.
    const seps = ["\\u0000", "\\u0001", " ", "|", '"', "\\", "\n", "[]"];
    for (const sep of seps) {
      const left = [
        makeSubagent({
          toolUseId: "tu",
          role: `a${sep}b`,
          activity: { toolName: "c", toolInput: {} },
        }),
      ];
      const right = [
        makeSubagent({
          toolUseId: "tu",
          role: "a",
          activity: { toolName: `b${sep}c`, toolInput: {} },
        }),
      ];
      const leftKey = subagentCardsKey(left);
      expect(leftKey).not.toBe(subagentCardsKey(right));
      expect(leftKey).toBe(subagentCardsKey(left));
      // Source-side discipline: no literal control bytes in the signature (git
      // would treat the module as binary, blinding diff / rg).
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(leftKey)).toBe(
        false
      );
    }
  });
});

describe("settledSpawnCardFromBlock — 无 live 列表时的持久 line 1", () => {
  const settled = (input: unknown) =>
    settledSpawnCardFromBlock({
      name: "spawn_subagent",
      input,
      settled: true,
      cols: 60,
    });

  test("非 spawn 工具名 / 未落定的 spawn → null（各有别的宿主负责）", () => {
    expect(
      settledSpawnCardFromBlock({
        name: "Bash",
        input: { title: "甲" },
        settled: true,
        cols: 60,
      })
    ).toBeNull();
    expect(
      settledSpawnCardFromBlock({
        name: "spawn_subagent",
        input: { title: "甲" },
        settled: false,
        cols: 60,
      })
    ).toBeNull();
  });

  test("title 持久可读 → line 1 是它（trim 后），line 2 是空槽不是 ✓ Done", () => {
    const card = settled({ task: "整理一下", title: "  整理报告  " });
    expect(card).not.toBeNull();
    expect(card!.titleLine).toBe("整理报告");
    // `✓ Done` would claim a completion no worker is left to confirm; the
    // reloaded card keeps the two rows with a blank slot instead.
    expect(card!.detailLine).toBe("");
    expect(card!.done).toBe(false);
  });

  test("title 优先于 subagent_type，即使二者都像角色名", () => {
    const card = settled({
      task: "t",
      title: "explore",
      subagent_type: "bash-runner",
    });
    expect(card!.titleLine).toBe("explore");
  });

  test("无 title（缺省 / 空串 / 纯空白）→ 沿用 catalog 规则，且仍占两行", () => {
    expect(settled({ subagent_type: "explore" })!.titleLine).toBe("explore");
    expect(settled({ role: "plan" })!.titleLine).toBe("plan");
    for (const input of [{}, { title: "" }, { title: "   " }]) {
      const card = settled(input)!;
      expect(card.titleLine).toBe(IDENTITY_FALLBACK_ROLE);
      expect(card.detailLine).toBe("");
    }
  });

  test("input 非对象 → 不抛，落到 catalog 兜底名", () => {
    for (const input of [undefined, null, "str", 7, []]) {
      expect(settled(input)!.titleLine).toBe(IDENTITY_FALLBACK_ROLE);
    }
  });

  test("窄 cols → line 1 仍是一行（视觉宽度裁剪，不含换行）", () => {
    const card = settledSpawnCardFromBlock({
      name: "spawn_subagent",
      input: { title: "一".repeat(40) },
      settled: true,
      cols: 10,
    })!;
    expect(card.titleLine).not.toContain("\n");
    expect(visualWidth(card.titleLine)).toBeLessThanOrEqual(10);
  });
});
