/**
 * tests/tui/subagent-card-lines.test.ts
 *
 * specs/tui-subagent-transcript-live.md（锁句 1/2/5/6）—— 卡级两行投影的
 * 纯函数单测（无 OpenTUI / 无 React，直接 import 纯函数模块）。
 *
 * 不变式：一个活着的 `spawn_subagent` 在**会话 transcript 那张卡**占两行 ——
 * 第 1 行 `{role} running...`（三点），第 2 行 live 为 dim `taskPreview`、
 * completed 后原位变绿 `done`。join 键 = `SubagentInfo.toolUseId`，缺关联键
 * 既不产生卡行、也不借用别的 worker 的预览（锁句 6）。
 */
import { describe, expect, test } from "bun:test";
import {
  IDENTITY_FALLBACK_ROLE,
  isLiveSubagent,
  projectSubagentCardLines,
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

describe("projectSubagentCardLines — empty 与负向分支（锁句 6 的 EXIT 面）", () => {
  test("empty: subagents=[] → null", () => {
    expect(projectSubagentCardLines([], "toolu_1", 80)).toBeNull();
  });

  test("toolUseId 缺省 / 空串 / 纯空白 → null（不借别的 worker 的预览）", () => {
    const subs = [makeSubagent({ toolUseId: undefined })];
    expect(projectSubagentCardLines(subs, undefined, 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "", 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "   ", 80)).toBeNull();
    expect(projectSubagentCardLines(subs, "\t\n", 80)).toBeNull();
  });

  test("匹配不到该 toolUseId → null（不选第一个凑数）", () => {
    const subs = [
      makeSubagent({ toolUseId: "toolu_a", taskPreview: "A 的预览" }),
      makeSubagent({ toolUseId: "toolu_b", taskPreview: "B 的预览" }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_missing", 80)).toBeNull();
  });

  test("匹配到 failed → null（锁句 5：归该卡 failure overlay）", () => {
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
      makeSubagent({
        state: "running",
        toolUseId: "toolu_x",
        taskPreview: "活着的那条",
      }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_x", 80)).toEqual({
      roleLine: "general-purpose running...",
      detailLine: "活着的那条",
      done: false,
    });
  });
});

describe("projectSubagentCardLines — live 与 completed 的卡形状", () => {
  test("starting / running 都是 live：`{role} running...` + taskPreview，done=false", () => {
    const starting = projectSubagentCardLines(
      [
        makeSubagent({
          state: "starting",
          role: "explore",
          toolUseId: "toolu_s",
        }),
      ],
      "toolu_s",
      80
    );
    const running = projectSubagentCardLines(
      [
        makeSubagent({
          state: "running",
          role: "general-purpose",
          toolUseId: "toolu_r",
          taskPreview: "第一个任务",
        }),
      ],
      "toolu_r",
      80
    );
    expect(starting).toEqual({
      roleLine: "explore running...",
      detailLine: "查找文档",
      done: false,
    });
    expect(running).toEqual({
      roleLine: "general-purpose running...",
      detailLine: "第一个任务",
      done: false,
    });
  });

  test("completed：锁句 2 —— 第 1 行逐字不变，第 2 行 literally `done`，done=true", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          role: "explore",
          toolUseId: "toolu_done",
          taskPreview: "已完成的预览（不再显示）",
          endedAt: iso(-100),
          summary: "收尾摘要",
        }),
      ],
      "toolu_done",
      80
    );
    expect(card).not.toBeNull();
    expect(card!.roleLine).toBe("explore running...");
    expect(card!.detailLine).toBe("done");
    expect(card!.done).toBe(true);
    expect(card!.detailLine).not.toContain("✓");
  });

  test("completed 的 detailLine 恒为 `done`，即使 taskPreview 非空", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          taskPreview: "旧预览",
          toolUseId: "toolu_c",
        }),
      ],
      "toolu_c",
      80
    );
    expect(card!.detailLine).toBe("done");
  });

  test("只有 completed 产 done：starting / running 的 detailLine 不是 `done`", () => {
    for (const state of ["starting", "running"] as const) {
      const card = projectSubagentCardLines(
        [makeSubagent({ state, toolUseId: "toolu_l" })],
        "toolu_l",
        80
      );
      expect(card!.done).toBe(false);
      expect(card!.detailLine).not.toBe("done");
    }
  });
});

describe("projectSubagentCardLines — negative（role fallback / 空 preview）", () => {
  test("缺 role → catalog fallback general-purpose", () => {
    const card = projectSubagentCardLines(
      [makeSubagent({ role: undefined, toolUseId: "toolu_f" })],
      "toolu_f",
      80
    );
    expect(card!.roleLine).toBe(`${IDENTITY_FALLBACK_ROLE} running...`);
  });

  test("role 空串 / 纯空白 → fallback；` explore ` → trim 后原样", () => {
    const empty = projectSubagentCardLines(
      [makeSubagent({ role: "", toolUseId: "toolu_e" })],
      "toolu_e",
      80
    );
    const blank = projectSubagentCardLines(
      [makeSubagent({ role: "   ", toolUseId: "toolu_w" })],
      "toolu_w",
      80
    );
    const padded = projectSubagentCardLines(
      [makeSubagent({ role: " explore ", toolUseId: "toolu_p" })],
      "toolu_p",
      80
    );
    expect(empty!.roleLine).toBe("general-purpose running...");
    expect(blank!.roleLine).toBe("general-purpose running...");
    expect(padded!.roleLine).toBe("explore running...");
  });

  test("钉死约束：任何 role 输入都不输出「子代理」字面值", () => {
    const cases: ReadonlyArray<Partial<SubagentInfo>> = [
      {},
      { role: undefined },
      { role: "" },
      { role: "   " },
    ];
    for (const c of cases) {
      const card = projectSubagentCardLines(
        [makeSubagent({ ...c, toolUseId: "toolu_n" })],
        "toolu_n",
        80
      );
      expect(card!.roleLine).not.toContain("子代理");
    }
  });

  test("空 / 纯空白 taskPreview → detailLine 空串，卡仍是两行形状", () => {
    const empty = projectSubagentCardLines(
      [makeSubagent({ taskPreview: "", toolUseId: "toolu_z" })],
      "toolu_z",
      80
    );
    const blank = projectSubagentCardLines(
      [makeSubagent({ taskPreview: "  \t ", toolUseId: "toolu_b2" })],
      "toolu_b2",
      80
    );
    expect(empty).toEqual({
      roleLine: "general-purpose running...",
      detailLine: "",
      done: false,
    });
    expect(blank!.detailLine).toBe("");
    expect(typeof empty!.roleLine).toBe("string");
    expect(typeof empty!.detailLine).toBe("string");
  });
});

describe("projectSubagentCardLines — overflow（视觉宽度 ≤ cols，永不换行）", () => {
  test("超长 role + 超长 preview + cols=20 → 两行 ≤ 20 且无换行", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "a".repeat(100),
          taskPreview: "b".repeat(100),
          toolUseId: "toolu_o",
        }),
      ],
      "toolu_o",
      20
    );
    expect(visualWidth(card!.roleLine)).toBeLessThanOrEqual(20);
    expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(20);
    expect(card!.roleLine.includes("\n")).toBe(false);
    expect(card!.detailLine.includes("\n")).toBe(false);
  });

  test("CJK preview + 窄列 → 按视觉宽度（CJK 占 2 列）截断", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          taskPreview: "查找文档并且继续往下列出更多内容",
          toolUseId: "toolu_cjk",
        }),
      ],
      "toolu_cjk",
      12
    );
    expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(12);
  });

  test("cols = 1 退化 → 两行各 ≤ 1 列", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          taskPreview: "查找文档",
          toolUseId: "toolu_1col",
        }),
      ],
      "toolu_1col",
      1
    );
    expect(visualWidth(card!.roleLine)).toBeLessThanOrEqual(1);
    expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(1);
  });

  test("cols <= 0 → 1 列预算（不返回未截断原串）", () => {
    const subs = [
      makeSubagent({
        role: "explore",
        taskPreview: "查找文档",
        toolUseId: "toolu_zero",
      }),
    ];
    for (const cols of [0, -1, -80]) {
      const card = projectSubagentCardLines(subs, "toolu_zero", cols);
      expect(visualWidth(card!.roleLine)).toBeLessThanOrEqual(1);
      expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(1);
    }
  });
});

describe("projectSubagentCardLines — concurrent / exception", () => {
  test("两个 live worker：各卡只取自己 join 的 taskPreview，互不串", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_A",
        role: "explore",
        taskPreview: "A 的任务预览",
      }),
      makeSubagent({
        toolUseId: "toolu_B",
        role: "general-purpose",
        taskPreview: "B 的任务预览",
      }),
    ];
    const cardA = projectSubagentCardLines(subs, "toolu_A", 80);
    const cardB = projectSubagentCardLines(subs, "toolu_B", 80);
    expect(cardA!.detailLine).toBe("A 的任务预览");
    expect(cardB!.detailLine).toBe("B 的任务预览");
    expect(cardA!.detailLine).not.toContain("B 的任务预览");
    expect(cardB!.detailLine).not.toContain("A 的任务预览");
    expect(cardA!.roleLine).toBe("explore running...");
    expect(cardB!.roleLine).toBe("general-purpose running...");
  });

  test("同输入两次投影 → deepEqual（纯函数）", () => {
    const subs = [
      makeSubagent({ toolUseId: "toolu_p1", role: "explore" }),
      makeSubagent({ toolUseId: "toolu_p2", role: "general-purpose" }),
    ];
    expect(projectSubagentCardLines(subs, "toolu_p1", 80)).toEqual(
      projectSubagentCardLines(subs, "toolu_p1", 80)
    );
    expect(subagentCardLinesMap(subs, 80)).toEqual(
      subagentCardLinesMap(subs, 80)
    );
  });

  test("exception：非法 startedAt / 缺 endedAt / 缺 summary 不影响投影", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "explore",
          startedAt: "not-a-date",
          endedAt: undefined,
          summary: undefined,
          taskPreview: "查",
          toolUseId: "toolu_iso",
        }),
      ],
      "toolu_iso",
      80
    );
    expect(card).toEqual({
      roleLine: "explore running...",
      detailLine: "查",
      done: false,
    });
  });

  test("exception：completed 缺 endedAt / 非法 endedAt 不改变 done 判定", () => {
    const missing = projectSubagentCardLines(
      [makeSubagent({ state: "completed", toolUseId: "toolu_m" })],
      "toolu_m",
      80
    );
    const illegal = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          endedAt: "not-a-date",
          startedAt: "also-not-a-date",
          toolUseId: "toolu_i",
        }),
      ],
      "toolu_i",
      80
    );
    expect(missing!.done).toBe(true);
    expect(illegal!.done).toBe(true);
    expect(illegal!.detailLine).toBe("done");
  });
});

describe("subagentCardLinesMap — 逐卡 map（key = toolUseId）", () => {
  test("empty：[] → 空 map", () => {
    const map = subagentCardLinesMap([], 80);
    expect(map.size).toBe(0);
    expect(map.get("toolu_any")).toBeUndefined();
  });

  test("live + completed 都入 map", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_live",
          state: "running",
          role: "explore",
          taskPreview: "进行中",
        }),
        makeSubagent({
          toolUseId: "toolu_done",
          state: "completed",
          role: "general-purpose",
          endedAt: iso(-100),
        }),
      ],
      80
    );
    expect(map.size).toBe(2);
    expect(map.get("toolu_live")).toEqual({
      roleLine: "explore running...",
      detailLine: "进行中",
      done: false,
    });
    expect(map.get("toolu_done")).toEqual({
      roleLine: "general-purpose running...",
      detailLine: "done",
      done: true,
    });
  });

  test("缺 toolUseId 的条目整体跳过", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({ toolUseId: undefined, taskPreview: "无关联键" }),
        makeSubagent({ toolUseId: "toolu_has", taskPreview: "有关联键" }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.has("toolu_has")).toBe(true);
    expect([...map.values()].map((c) => c.detailLine)).toEqual(["有关联键"]);
  });

  test("failed 条目整体跳过（锁句 5）", () => {
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

  test("重复 toolUseId → 列表序首个胜", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_dup",
          role: "explore",
          taskPreview: "第一个",
        }),
        makeSubagent({
          toolUseId: "toolu_dup",
          role: "general-purpose",
          taskPreview: "第二个",
        }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.get("toolu_dup")).toEqual({
      roleLine: "explore running...",
      detailLine: "第一个",
      done: false,
    });
  });

  test("failed 条目整条跳过、不占位：同键的后续合格条目仍按首个合格者入 map", () => {
    // spec「Input-contract classes」：failed 条目整体跳过（不入 map）；重复键
    // 在**合格条目**之间取列表序首个 —— 被跳过的条目不为该键占位。
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          state: "failed",
          toolUseId: "toolu_dup",
          endedAt: iso(-1),
        }),
        makeSubagent({
          state: "running",
          toolUseId: "toolu_dup",
          taskPreview: "第二个",
        }),
      ],
      80
    );
    expect(map.size).toBe(1);
    expect(map.get("toolu_dup")).toEqual({
      roleLine: "general-purpose running...",
      detailLine: "第二个",
      done: false,
    });
  });

  test("空串 toolUseId 的条目跳过", () => {
    const map = subagentCardLinesMap(
      [makeSubagent({ toolUseId: "", taskPreview: "空键" })],
      80
    );
    expect(map.size).toBe(0);
  });

  test("overflow：map 内每条也按 cols 截断", () => {
    const map = subagentCardLinesMap(
      [
        makeSubagent({
          toolUseId: "toolu_long",
          role: "a".repeat(50),
          taskPreview: "查找文档并且继续往下列出更多内容",
        }),
      ],
      10
    );
    const card = map.get("toolu_long")!;
    expect(visualWidth(card.roleLine)).toBeLessThanOrEqual(10);
    expect(visualWidth(card.detailLine)).toBeLessThanOrEqual(10);
  });

  test("与 projectSubagentCardLines 同源：map 取出的卡 = 单卡投影", () => {
    const subs = [
      makeSubagent({
        toolUseId: "toolu_src",
        role: "explore",
        taskPreview: "同源",
      }),
    ];
    expect(subagentCardLinesMap(subs, 30).get("toolu_src")).toEqual(
      projectSubagentCardLines(subs, "toolu_src", 30)
    );
  });

  test("非法 ISO / 缺终态字段不影响 map 判定", () => {
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
      roleLine: "general-purpose running...",
      detailLine: "done",
      done: true,
    });
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

describe("subagentCardsKey — useMemo 依赖签名（1Hz 轮询不炸历史 memo）", () => {
  test("同内容不同数组引用 → 同签名（轮询每次 setSubagents 新数组不得让下游重投影）", () => {
    const a = [makeSubagent({ toolUseId: "toolu_k1" })];
    const b = [...a];
    expect(b).not.toBe(a);
    expect(subagentCardsKey(b)).toBe(subagentCardsKey(a));
  });

  test("投影读取的四个字段任一变化 → 签名变化（漏一字段 = 缓存返回过期卡片）", () => {
    const base = [makeSubagent({ toolUseId: "toolu_k2" })];
    const fields: ReadonlyArray<Partial<SubagentInfo>> = [
      { toolUseId: "toolu_k2_other" },
      { state: "completed" },
      { role: "explore" },
      { taskPreview: "另一个预览" },
    ];
    for (const patch of fields) {
      expect(
        subagentCardsKey([makeSubagent({ ...base[0]!, ...patch })])
      ).not.toBe(subagentCardsKey(base));
    }
  });

  test("空数组 / 顺序敏感：签名是纯函数（同入参两次调用逐字相等）", () => {
    // 空数组的签名 = 空 JSON 数组字面（编码走 JSON.stringify，见函数注释）。
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
    // role（`subagent_type` 入参）与 taskPreview（`def.task`）都是模型给的
    // 任意字符串。若签名靠字面分隔符拼接，下面两条**不同的**元组会拼出同
    // 一串（`a` + sep + `b` + sep + `c`）→ memo 返回上一个 worker 的卡。
    // 每个候选分隔符都要挡：JSON 转义让字段边界不可伪造。
    const seps = [
      "\\u0000", // NUL：曾被用作字面分隔符（且让模块被 git 当二进制）
      "\\u0001",
      " ",
      "|",
      '"',
      "\\",
      "\n",
      "[]",
    ];
    for (const sep of seps) {
      const left = [
        makeSubagent({
          toolUseId: "tu",
          role: `a${sep}b`,
          taskPreview: "c",
        }),
      ];
      const right = [
        makeSubagent({
          toolUseId: "tu",
          role: "a",
          taskPreview: `b${sep}c`,
        }),
      ];
      const leftKey = subagentCardsKey(left);
      expect(leftKey).not.toBe(subagentCardsKey(right));
      expect(leftKey).toBe(subagentCardsKey(left)); // 纯函数
      // 源码侧纪律：签名里不得出现**字面控制字节**（会让 git 把模块当
      // 二进制，diff / rg 双双失明）—— 必须走 JSON 转义。
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(leftKey)).toBe(
        false
      );
    }
  });
});
