/**
 * TUI run_graph chrome line.
 *
 * No snapshot → 0 rows; with a snapshot → always 1 English line `graph` +
 * counts + now; stays a single line on narrow screens.
 */
import { describe, expect, test } from "bun:test";
import type { GraphProgressSnapshot } from "../../src/harness/graph/progress.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import { chromeReserveRows } from "../../src/tui/app.js";
import {
  graphChromeLine,
  graphChromeRows,
  graphProgressFromEvent,
  reduceGraphChromeFocus,
} from "../../src/tui/graph-chrome.js";

function snap(
  nodes: GraphProgressSnapshot["nodes"],
  waveIndex = 0
): GraphProgressSnapshot {
  return { waveIndex, nodes };
}

describe("graphProgressFromEvent", () => {
  test("graph_progress live → 完整快照；null → 清除", () => {
    const live: HarnessStreamEvent = {
      type: "graph_progress",
      snapshot: snap([{ id: "a", deps: [], status: "running" }]),
    };
    expect(graphProgressFromEvent(live)?.nodes[0]?.id).toBe("a");
    expect(
      graphProgressFromEvent({ type: "graph_progress", snapshot: null })
    ).toBeNull();
  });

  test("非 graph_progress → undefined（调用方保持旧槽）", () => {
    expect(
      graphProgressFromEvent({ type: "text_delta", text: "x" })
    ).toBeUndefined();
  });
});

describe("graphChromeLine", () => {
  test("无快照 → 空（不出现该行）", () => {
    expect(graphChromeLine(null, 80, false)).toBeNull();
  });

  test("有快照：英文 graph + done 计数 + now 节点", () => {
    const line = graphChromeLine(
      snap([
        { id: "research", deps: [], status: "done", summary: "ok" },
        { id: "write", deps: ["research"], status: "running" },
        { id: "wait", deps: ["write"], status: "pending" },
      ]),
      80,
      false
    );
    expect(line).not.toBeNull();
    expect(line!.text).toContain("graph");
    expect(line!.text).toContain("1/3");
    expect(line!.text).toContain("write");
    expect(line!.text.startsWith(">")).toBe(false);
  });

  test("焦点行首 >", () => {
    const line = graphChromeLine(
      snap([{ id: "a", deps: [], status: "running" }]),
      80,
      true
    );
    expect(line!.text.startsWith("> ")).toBe(true);
  });

  test("窄屏仍单行（不折成产品多行）", () => {
    const line = graphChromeLine(
      snap([
        {
          id: "very-long-node-name-that-would-wrap",
          deps: [],
          status: "running",
        },
      ]),
      24,
      false
    );
    expect(line).not.toBeNull();
    expect(line!.text.includes("\n")).toBe(false);
    expect(line!.text.length).toBeLessThanOrEqual(24);
  });
});

describe("chromeReserveRows — graphRows", () => {
  const base = {
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  } as const;

  test("缺省 / 0 → baseline 7 不变", () => {
    expect(chromeReserveRows(base)).toBe(7);
    expect(chromeReserveRows({ ...base, graphRows: 0 })).toBe(7);
  });

  test("graphRows=1 → 预算 +1", () => {
    expect(chromeReserveRows({ ...base, graphRows: 1 })).toBe(8);
  });
});

describe("reduceGraphChromeFocus", () => {
  test("无快照：down/tab 仍停在 input", () => {
    expect(
      reduceGraphChromeFocus({
        focus: "input",
        hasSnapshot: false,
        key: "down",
      })
    ).toEqual({ focus: "input" });
  });

  test("有快照：down/tab 从 input 落到 graph", () => {
    expect(
      reduceGraphChromeFocus({
        focus: "input",
        hasSnapshot: true,
        key: "tab",
      })
    ).toEqual({ focus: "graph" });
  });

  test("graph 上 esc/up 回到 input；enter 打开分组视图", () => {
    expect(
      reduceGraphChromeFocus({
        focus: "graph",
        hasSnapshot: true,
        key: "escape",
      })
    ).toEqual({ focus: "input" });
    expect(
      reduceGraphChromeFocus({
        focus: "graph",
        hasSnapshot: true,
        key: "return",
      })
    ).toEqual({ focus: "graph", openView: true });
  });

  test("快照消失 → 焦点收回 input", () => {
    expect(
      reduceGraphChromeFocus({
        focus: "graph",
        hasSnapshot: false,
        key: "down",
      })
    ).toEqual({ focus: "input" });
  });
});

describe("graphChromeRows", () => {
  test("无快照 0 行；有快照恒 1 行", () => {
    expect(graphChromeRows(null)).toBe(0);
    expect(
      graphChromeRows(snap([{ id: "a", deps: [], status: "running" }]))
    ).toBe(1);
  });
});
