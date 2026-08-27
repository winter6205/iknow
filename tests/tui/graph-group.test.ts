/**
 * run_graph 语义分组纯函数（spec A5 / SC2 / plan T3）。
 */
import { describe, expect, test } from "bun:test";
import type { GraphProgressSnapshot } from "../../src/harness/graph/progress.js";
import {
  GRAPH_GLYPH,
  graphGroupRows,
  groupGraphSnapshot,
  selectedNodeContext,
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
