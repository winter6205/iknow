/**
 * TUI run_graph 进度快照（plans/tui-run-graph-view.md T1）。
 *
 * 纯累加：onWave 把本波标 running；onNode 写入终态；不读 JSONL。
 */
import { describe, expect, it } from "vitest";
import { createGraphProgressTracker } from "../../../src/harness/graph/progress.ts";

const NODES = [
  { id: "research", deps: [] },
  { id: "write", deps: ["research"] },
  { id: "after", deps: ["write"] },
] as const;

describe("createGraphProgressTracker", () => {
  it("初始全部 pending，含 id / deps / waveIndex", () => {
    const t = createGraphProgressTracker(NODES);
    const snap = t.snapshot();
    expect(snap.waveIndex).toBe(-1);
    expect(snap.nodes.map((n) => n.id)).toEqual([
      "research",
      "write",
      "after",
    ]);
    expect(snap.nodes.map((n) => n.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(snap.nodes.find((n) => n.id === "write")!.deps).toEqual(["research"]);
  });

  it("空节点列表 → 空快照（不画行的数据前提）", () => {
    const t = createGraphProgressTracker([]);
    expect(t.snapshot().nodes).toEqual([]);
    expect(t.snapshot().waveIndex).toBe(-1);
  });

  it("onWave 把本波 id 标 running，其余仍 pending", () => {
    const t = createGraphProgressTracker(NODES);
    const snap = t.onWave(0, ["research"]);
    expect(snap.waveIndex).toBe(0);
    expect(snap.nodes.find((n) => n.id === "research")!.status).toBe("running");
    expect(snap.nodes.find((n) => n.id === "write")!.status).toBe("pending");
  });

  it("onNode 随终态更新 summary；skipped 保留 reason", () => {
    const t = createGraphProgressTracker(NODES);
    t.onWave(0, ["research"]);
    t.onNode({ id: "research", status: "failed", error: "boom" });
    const afterSkip = t.onNode({
      id: "write",
      status: "skipped",
      reason: 'upstream node "research" did not complete',
    });
    expect(afterSkip.nodes.find((n) => n.id === "research")).toMatchObject({
      status: "failed",
      summary: "boom",
    });
    expect(afterSkip.nodes.find((n) => n.id === "write")).toMatchObject({
      status: "skipped",
      summary: 'upstream node "research" did not complete',
    });
  });

  it("同波并发：两个 id 同时 running，再各自 done", () => {
    const t = createGraphProgressTracker([
      { id: "a", deps: [] },
      { id: "b", deps: [] },
    ]);
    const running = t.onWave(0, ["a", "b"]);
    expect(running.nodes.map((n) => n.status)).toEqual(["running", "running"]);
    t.onNode({ id: "a", status: "done", output: "A" });
    const done = t.onNode({ id: "b", status: "done", output: "B" });
    expect(done.nodes.map((n) => n.status)).toEqual(["done", "done"]);
    expect(done.nodes.map((n) => n.summary)).toEqual(["A", "B"]);
  });

  it("节点数溢出仍全量保留（分组视图滚动，热路径不截 N）", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      deps: [] as string[],
    }));
    const t = createGraphProgressTracker(many);
    const snap = t.onWave(
      0,
      many.map((n) => n.id)
    );
    expect(snap.nodes).toHaveLength(40);
    expect(snap.nodes.every((n) => n.status === "running")).toBe(true);
  });

  it("onWave→onNode 记录 durationMs（可注入 nowMs）", () => {
    let now = 1_000;
    const t = createGraphProgressTracker(NODES, { nowMs: () => now });
    t.onWave(0, ["research"]);
    now = 2_500;
    const snap = t.onNode({ id: "research", status: "done", output: "FACT" });
    expect(snap.nodes.find((n) => n.id === "research")!.durationMs).toBe(1_500);
    expect(snap.nodes.find((n) => n.id === "write")!.durationMs).toBeUndefined();
  });

  it("超长 output 截成粗摘要，不整包塞进 snapshot", () => {
    const t = createGraphProgressTracker([{ id: "solo", deps: [] }]);
    t.onWave(0, ["solo"]);
    const snap = t.onNode({
      id: "solo",
      status: "done",
      output: "Z".repeat(800),
    });
    const summary = snap.nodes[0]!.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(summary.startsWith("Z")).toBe(true);
  });
});
