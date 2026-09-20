/**
 * tests/tui/chrome-focus.test.ts
 *
 * Pure-function unit tests for the chrome-focus reducer.
 *
 * Invariants (the reducer must never break a single one):
 *   1) focus states: `input` | `subagent(row)` | `graph` — owned solely by
 *      the reducer;
 *   2) Down from input → first subagent row (if any) / graph (no subagents
 *      but a snapshot exists); neither → stays at input (empty boundary).
 *   3) Up from subagent(0) → input; Down from subagent(last) → graph (if
 *      any) / stays;
 *   4) Up from graph → last subagent row (if any) / input (no subagents).
 *   5) any other key (return / escape / tab / plain chars) → focus unchanged
 *      (the reducer only recognizes Down/Up; Escape / Tab / Enter stay with
 *      other reducers / components; the reducer never steals keys).
 *   6) missing snapshot / empty panel → that hop is skipped (empty /
 *      exception).
 *   7) all inputs are readonly; the reducer is pure: same inputs → same
 *      output.
 *   8) row clamp: when the subagent row count changes, an out-of-range row
 *      clamps back to [0, count-1] / switches to input.
 *
 * Wiring lives in the app layer; this reducer is covered only by
 * pure-function tests here. PromptInput is not involved.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChromeFocus,
  reduceChromeFocus,
} from "../../src/tui/chrome-focus.js";

describe("reduceChromeFocus — input 起点（empty 边界）", () => {
  test("无 subagent 无 graph：Down from input 原地", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "down",
        subagentCount: 0,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("无 subagent 有 graph：Down from input → graph", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "down",
        subagentCount: 0,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "graph" } });
  });

  test("有 subagent 无 graph：Down from input → subagent(0)", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "down",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 0 } });
  });

  test("input 上 Up：原地（input 已经是焦点起点）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "up",
        subagentCount: 5,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });
});

describe("reduceChromeFocus — subagent 行间移动", () => {
  test("subagent(0) 上 Up → input", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 0 },
        key: "up",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("subagent(中间行) 上 Down → 下一行", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 1 },
        key: "down",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 2 } });
  });

  test("subagent(中间行) 上 Up → 上一行", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 2 },
        key: "up",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 1 } });
  });

  test("subagent(最后行) 上 Down：无 graph → 原地；overflow clamp 不越界", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 2 },
        key: "down",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 2 } });
  });

  test("subagent(最后行) 上 Down：有 graph → graph", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 2 },
        key: "down",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "graph" } });
  });
});

describe("reduceChromeFocus — graph 环", () => {
  test("graph 上 Up：有 subagent → 最后一个 subagent 行", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "up",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "subagent", row: 2 } });
  });

  test("graph 上 Up：无 subagent → input", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "up",
        subagentCount: 0,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("graph 上 Down：原地（最末环）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "down",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "graph" } });
  });
});

describe("reduceChromeFocus — overflow / clamp 边界", () => {
  test("row 越界（subagent 行数变 0，原 row=2）→ 回 input", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 2 },
        key: "up",
        subagentCount: 0,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("row 越界（subagent 行数缩到 2，原 row=5）→ clamp 到 last，再 up → last-1", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 5 },
        key: "up",
        subagentCount: 2,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 0 } });
  });

  test("snapshot 突然消失：graph 焦点回 input（exception 跳过该环）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "up",
        subagentCount: 0,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("snapshot 突然消失：graph 焦点在 down 上也回 input", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "down",
        subagentCount: 0,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("subagent 行数极多（50）→ row 23 上 Down → row 24（clamp 不到溢出）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 23 },
        key: "down",
        subagentCount: 50,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 24 } });
  });

  test("subagent 行数极多（50）→ 最后行 Down 有 graph → graph", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 49 },
        key: "down",
        subagentCount: 50,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "graph" } });
  });
});

describe("reduceChromeFocus — negative 边界（非 down/up 不抢键）", () => {
  test("input 上 Enter：原地（reducer 不抢键，Enter 由 prompt-input 自处理）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "return",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("input 上 Escape：原地", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "escape",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("input 上 Tab：原地（reducer 不抢 Tab —— Tab 归 slash / 子代理 hint）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "tab",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("input 上普通字符 'a'：原地", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "a",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("subagent 上普通字符：原地", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: 1 },
        key: "x",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "subagent", row: 1 } });
  });

  test("graph 上 Enter：原地（return 仍由其他 reducer 抢 openView）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "graph" },
        key: "return",
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "graph" } });
  });
});

describe("reduceChromeFocus — concurrent / purity 隔离", () => {
  test("no-op 返回入参 focus 原引用（调用方 !== 身份比较探测真实变化；契约见 T7 onLeaveToChrome）", () => {
    const focus: ChromeFocus = { kind: "graph" };
    const noOp = reduceChromeFocus({
      focus,
      key: "down",
      subagentCount: 3,
      hasSnapshot: true,
    });
    expect(noOp.focus).toBe(focus);
    const inputStays: ChromeFocus = { kind: "input" };
    expect(
      reduceChromeFocus({
        focus: inputStays,
        key: "up",
        subagentCount: 0,
        hasSnapshot: false,
      }).focus
    ).toBe(inputStays);
  });

  test("两次连续 reduce 互不污染（同一 input → 同样 output）", () => {
    const input = {
      focus: { kind: "input" } as ChromeFocus,
      key: "down" as const,
      subagentCount: 3,
      hasSnapshot: true,
    };
    const a = reduceChromeFocus(input);
    const b = reduceChromeFocus(input);
    expect(a).toEqual(b);
    expect(a).toEqual({ focus: { kind: "subagent", row: 0 } });
  });

  test("reducer 不读 / 不写任何外部可变状态（相同 inputs 必同样 outputs）", () => {
    const base = {
      focus: { kind: "subagent", row: 1 } as ChromeFocus,
      key: "down" as const,
      subagentCount: 3,
      hasSnapshot: true,
    };
    const first = reduceChromeFocus(base);
    const second = reduceChromeFocus(base);
    expect(first).toEqual(second);
    expect(first).toEqual({ focus: { kind: "subagent", row: 2 } });
  });

  test("reducer 不抛：异常 input（NaN key）→ 原地（防御兜底）", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "" as never,
        subagentCount: 3,
        hasSnapshot: true,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("reducer 不抛：负 subagentCount → 按 0 处理", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "input" },
        key: "down",
        subagentCount: -1,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });

  test("reducer 不抛：负 row → clamp 到 0 / 回 input", () => {
    expect(
      reduceChromeFocus({
        focus: { kind: "subagent", row: -1 },
        key: "up",
        subagentCount: 3,
        hasSnapshot: false,
      })
    ).toEqual({ focus: { kind: "input" } });
  });
});
