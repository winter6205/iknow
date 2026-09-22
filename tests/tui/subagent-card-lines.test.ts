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
 * 2 is one activity slot — the joined worker's in-flight tool name while live,
 * the literal `✓ Done` once completed, nothing when failed (that card's failure
 * overlay owns it). The card is exactly two lines in every state: `taskPreview`
 * left the card (it stays on `SubagentInfo` / `SubagentPanel`).
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
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

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

describe("SC2 — live 卡：第 1 行 title，第 2 行 in-flight 工具名", () => {
  test("starting / running 都是 live：title + 工具名，done=false，且只有两行", () => {
    for (const state of ["starting", "running"] as const) {
      const info = makeSubagent({
        state,
        role: "explore",
        toolUseId: "toolu_live",
        title: "查文档",
        inFlightTool: "read_file",
      });
      const card = projectSubagentCardLines([info], "toolu_live", 80);
      expect(card).toEqual({
        titleLine: "查文档",
        detailLine: "read_file",
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
      inFlightTool: "bash",
    });
    const card = projectSubagentCardLines([info], "toolu_prev", 80)!;
    expect(card.titleLine).toBe("跑测试");
    expect(card.detailLine).toBe("bash");
    expect(card.titleLine + card.detailLine).not.toContain("任务正文");
  });

  test('无 in-flight（字段缺席或 ""）→ 第 2 行空占位，卡仍是两行', () => {
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
          inFlightTool: "",
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
          inFlightTool: "grep",
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

  test("终态即使带着陈旧 in-flight 名也只画 `✓ Done`（槽位不并存）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          toolUseId: "toolu_stale",
          endedAt: iso(100),
          inFlightTool: "read_file",
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

describe("SC4 — 两个并发 worker：标题与工具名各自独立，永不串行", () => {
  test("两张卡只吃自己 join 的那条 in-flight 名与自己 spawn record 的 title", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_A",
        role: "explore",
        title: "找调用点",
        inFlightTool: "grep",
      }),
      makeSubagent({
        toolUseId: "toolu_B",
        role: "general-purpose",
        title: "跑测试",
        inFlightTool: "bash",
      }),
    ];
    const cardA = projectSubagentCardLines(subs, "toolu_A", 80)!;
    const cardB = projectSubagentCardLines(subs, "toolu_B", 80)!;
    expect(cardA.titleLine).toBe("找调用点");
    expect(cardB.titleLine).toBe("跑测试");
    expect(cardA.detailLine).toBe("grep");
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
          inFlightTool: "b".repeat(100),
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
        inFlightTool: "read_file",
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
          inFlightTool: "grep",
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
    expect(map.get("toolu_live")).toEqual({
      titleLine: "进行中",
      detailLine: "grep",
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
          inFlightTool: "grep",
        }),
        makeSubagent({
          toolUseId: "toolu_dup",
          role: "general-purpose",
          inFlightTool: "bash",
        }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.get("toolu_dup")).toEqual({
      titleLine: "explore",
      detailLine: "grep",
      done: false,
    });
  });

  test("与 projectSubagentCardLines 同源：map 取出的卡 = 单卡投影", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_src",
        title: "同源",
        inFlightTool: "read_file",
      }),
    ];
    expect(subagentCardLinesMap(subs, 30).get("toolu_src")).toEqual(
      projectSubagentCardLines(subs, "toolu_src", 30)
    );
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
        inFlightTool: "grep",
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
        inFlightTool: "grep",
      }),
    ];
    const fields: ReadonlyArray<Partial<SubagentInfo>> = [
      { toolUseId: "toolu_k2_other" },
      { state: "completed" },
      { role: "general-purpose" },
      { title: "乙" },
      { inFlightTool: "bash" },
    ];
    for (const patch of fields) {
      expect(
        subagentCardsKey([makeSubagent({ ...base[0]!, ...patch })])
      ).not.toBe(subagentCardsKey(base));
    }
  });

  test('in-flight 名从「缺席」到 ""（读取完成、无调用在飞）也要换签名', () => {
    const pending = [makeSubagent({ toolUseId: "toolu_k5" })];
    const settled = [makeSubagent({ toolUseId: "toolu_k5", inFlightTool: "" })];
    expect(subagentCardsKey(settled)).not.toBe(subagentCardsKey(pending));
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
    // role (the `subagent_type` argument) and inFlightTool (a tool name) are
    // arbitrary strings. If the signature were joined with a literal separator,
    // the two **different** tuples below would serialize to one string → the
    // memo would return the previous worker's card. JSON escaping makes field
    // boundaries unforgeable.
    const seps = ["\\u0000", "\\u0001", " ", "|", '"', "\\", "\n", "[]"];
    for (const sep of seps) {
      const left = [
        makeSubagent({ toolUseId: "tu", role: `a${sep}b`, inFlightTool: "c" }),
      ];
      const right = [
        makeSubagent({ toolUseId: "tu", role: "a", inFlightTool: `b${sep}c` }),
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
