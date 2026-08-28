/**
 * run_graph 语义分组纯函数（spec A5 / SC2 / plan T3）。
 */
import { describe, expect, test } from "bun:test";
import type { GraphProgressSnapshot } from "../../src/harness/graph/progress.js";
import {
  GRAPH_GLYPH,
  formatGraphNodeDetail,
  graphGroupRows,
  groupGraphSnapshot,
  moveSelection,
  reduceGraphViewKey,
  selectedNodeContext,
  selectableNodeIds,
  sliceGraphViewRows,
} from "../../src/tui/graph-group.js";

function snap(
  nodes: GraphProgressSnapshot["nodes"]
): GraphProgressSnapshot {
  return { waveIndex: 0, nodes };
}

describe("GRAPH_GLYPH", () => {
  test("集合为 *+x-.", () => {
    expect(GRAPH_GLYPH.running).toBe("*");
    expect(GRAPH_GLYPH.done).toBe("+");
    expect(GRAPH_GLYPH.failed).toBe("x");
    expect(GRAPH_GLYPH.skipped).toBe("-");
    expect(GRAPH_GLYPH.pending).toBe(".");
  });
});

describe("groupGraphSnapshot", () => {
  const fixture = snap([
    { id: "research", deps: [], status: "done", summary: "facts" },
    { id: "boom", deps: [], status: "failed", summary: "boom-err" },
    { id: "skip", deps: ["boom"], status: "skipped", summary: 'upstream "boom"' },
    { id: "write", deps: ["research"], status: "running" },
    { id: "waitA", deps: ["write"], status: "pending" },
    { id: "waitB", deps: ["write"], status: "pending" },
    { id: "later", deps: ["waitA"], status: "pending" },
  ]);

  test("now / issues(+skipped) / done / waiting 分簇", () => {
    const g = groupGraphSnapshot(fixture);
    expect(g.now.map((n) => n.id)).toEqual(["write"]);
    expect(g.issues.map((n) => n.id)).toEqual(["boom"]);
    expect(g.issues[0]!.skipped.map((n) => n.id)).toEqual(["skip"]);
    expect(g.done.map((n) => n.id)).toEqual(["research"]);
    const waitKeys = g.waiting.map((c) => c.on);
    expect(waitKeys).toContain("write");
    const onWrite = g.waiting.find((c) => c.on === "write")!;
    expect(onWrite.nodes.map((n) => n.id).sort()).toEqual(["waitA", "waitB"]);
  });

  test("空图 → 空分组", () => {
    const g = groupGraphSnapshot(snap([]));
    expect(g.now).toEqual([]);
    expect(g.issues).toEqual([]);
    expect(g.done).toEqual([]);
    expect(g.waiting).toEqual([]);
  });

  test("无失败时 skipped 不丢：挂在 issues 空、仍可从 waiting/done 之外扫到", () => {
    const g = groupGraphSnapshot(
      snap([{ id: "orphan", deps: ["ghost"], status: "skipped", summary: "x" }])
    );
    expect(g.issues).toHaveLength(1);
    expect(g.issues[0]!.id).toBe("orphan");
    expect(g.issues[0]!.skipped).toEqual([]);
  });
});

describe("graphGroupRows", () => {
  test("标题 dim 标记；正文带 glyph", () => {
    const rows = graphGroupRows(
      snap([{ id: "a", deps: [], status: "running" }]),
      "a"
    );
    expect(rows.some((r) => r.kind === "header" && r.text === "now")).toBe(
      true
    );
    expect(rows.some((r) => r.text.includes("* a"))).toBe(true);
  });

  test("waiting on <id> 与 selected 块都出现", () => {
    const rows = graphGroupRows(
      snap([
        { id: "write", deps: [], status: "running" },
        { id: "waitA", deps: ["write"], status: "pending" },
      ]),
      "write"
    );
    expect(rows.some((r) => r.text === "waiting on write")).toBe(true);
    expect(rows.some((r) => r.text === "selected")).toBe(true);
    expect(
      rows.some((r) => r.text.includes("write") && r.text.includes("unlocks"))
    ).toBe(true);
  });
});

describe("moveSelection / selectableNodeIds", () => {
  const ids = ["a", "b", "c"];

  test("空列表 → null", () => {
    expect(moveSelection([], "a", 1)).toBeNull();
    expect(selectableNodeIds([{ key: "h", kind: "header", text: "now", dim: true }])).toEqual(
      []
    );
  });

  test("视图内 down/up 夹在两端，不环绕", () => {
    expect(moveSelection(ids, "a", 1)).toBe("b");
    expect(moveSelection(ids, "c", 1)).toBe("c");
    expect(moveSelection(ids, "a", -1)).toBe("a");
    expect(moveSelection(ids, null, 1)).toBe("b");
  });
});

describe("reduceGraphViewKey", () => {
  const ids = ["a", "b"];

  test("up/down 改选中；enter 进详情；esc 逐级退出", () => {
    expect(
      reduceGraphViewKey({
        key: "down",
        selectedId: "a",
        detail: false,
        selectableIds: ids,
      })
    ).toEqual({ kind: "select", selectedId: "b" });
    expect(
      reduceGraphViewKey({
        key: "up",
        selectedId: "b",
        detail: false,
        selectableIds: ids,
      })
    ).toEqual({ kind: "select", selectedId: "a" });
    expect(
      reduceGraphViewKey({
        key: "return",
        selectedId: "a",
        detail: false,
        selectableIds: ids,
      })
    ).toEqual({ kind: "open-detail" });
    expect(
      reduceGraphViewKey({
        key: "escape",
        selectedId: "a",
        detail: true,
        selectableIds: ids,
      })
    ).toEqual({ kind: "close-detail" });
    expect(
      reduceGraphViewKey({
        key: "escape",
        selectedId: "a",
        detail: false,
        selectableIds: ids,
      })
    ).toEqual({ kind: "close-view" });
  });
});

describe("formatGraphNodeDetail", () => {
  test("last + 耗时；无 last 走占位", () => {
    expect(
      formatGraphNodeDetail({
        id: "a",
        deps: [],
        status: "done",
        summary: "facts",
        durationMs: 1500,
      })
    ).toContain("facts");
    expect(
      formatGraphNodeDetail({
        id: "a",
        deps: [],
        status: "done",
        summary: "facts",
        durationMs: 1500,
      })
    ).toContain("1500ms");
    expect(
      formatGraphNodeDetail({
        id: "b",
        deps: [],
        status: "failed",
      })
    ).toBe("(no last output)");
  });
});

describe("selectedNodeContext", () => {
  const fixture = snap([
    { id: "a", deps: [], status: "done", summary: "out-a" },
    { id: "b", deps: ["a"], status: "pending" },
    { id: "c", deps: ["a"], status: "pending" },
  ]);

  test("needs / unlocks / last", () => {
    const ctx = selectedNodeContext(fixture, "a");
    expect(ctx).not.toBeNull();
    expect(ctx!.needs).toEqual([]);
    expect(ctx!.unlocks).toEqual(["b", "c"]);
    expect(ctx!.last).toBe("out-a");
  });

  test("未知 id → null", () => {
    expect(selectedNodeContext(fixture, "nope")).toBeNull();
  });
});

describe("sliceGraphViewRows", () => {
  test("行数超过视口时窗口跟随选中节点", () => {
    const many = snap(
      Array.from({ length: 30 }, (_, i) => ({
        id: `n${i}`,
        deps: [] as string[],
        status: "done" as const,
      }))
    );
    const all = graphGroupRows(many, "n20");
    const sliced = sliceGraphViewRows(all, "n20", 8);
    expect(sliced.length).toBe(8);
    expect(sliced.some((r) => r.nodeId === "n20")).toBe(true);
  });
});
