/**
 * tests/tui/chrome-focus.test.ts
 *
 * plans/tui-chrome-interaction.md T6：chrome-focus reducer 纯函数单测。
 *
 * 不变量（reducer 一字不可破）：
 *   1) 焦点状态：`input` | `subagent(row)` | `graph` —— reducer 独享；
 *   2) input 上 Down → 第一个 subagent 行（有则）/ graph（无 subagent 但有快照）；
 *      无 subagent 也无 graph → 原地 input（empty 边界）。
 *   3) subagent(0) 上 Up → input；subagent(last) 上 Down → graph（有则）/ 原地；
 *   4) graph 上 Up → 最后一个 subagent 行（有则）/ input（无 subagent）。
 *   5) 其他键（return / escape / tab / 普通字符）→ 焦点不变（reducer 只认 Down/Up，
 *      Escape / Tab / Enter 仍由其他 reducer / 组件处理；reducer 不抢键）。
 *   6) 缺 snapshot / 空 panel → 该环跳过（empty / exception）。
 *   7) 任意 inputs 都是 readonly；reducer 是纯函数：相同 inputs → 相同 output。
 *   8) row clamp：subagent 行数变化时 row 越界回 clamp 到 [0, count-1] / 切 input。
 *
 * wiring 在 T7；本轮 reducer 只被纯函数测试覆盖。PromptInput 不在本轮改动。
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
