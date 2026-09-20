/** @jsxImportSource @opentui/react */
/**
 * run_graph chrome / grouped-view rendering.
 * Tests the real panel projection; does not grep app.tsx source.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { GraphChromePanel } from "../../src/tui/graph-chrome.js";
import { GraphGroupView } from "../../src/tui/graph-group-view.js";
import type { GraphProgressSnapshot } from "../../src/harness/graph/progress.js";

const liveSnap: GraphProgressSnapshot = {
  waveIndex: 0,
  nodes: [
    { id: "research", deps: [], status: "done", summary: "FACT", durationMs: 800 },
    { id: "write", deps: ["research"], status: "running" },
    { id: "wait", deps: ["write"], status: "pending" },
  ],
};

describe("GraphChromePanel", () => {
  test("有快照 → 一行含 graph 与 now；无快照 → 不出现 graph", async () => {
    const live = await testRender(
      <GraphChromePanel snapshot={liveSnap} cols={80} focused={false} />,
      { width: 80, height: 3 }
    );
    await live.renderOnce();
    const liveFrame = live.captureCharFrame();
    expect(liveFrame).toContain("graph");
    expect(liveFrame).toContain("write");
    await live.renderer.destroy();

    const empty = await testRender(
      <GraphChromePanel snapshot={null} cols={80} focused={false} />,
      { width: 80, height: 3 }
    );
    await empty.renderOnce();
    expect(empty.captureCharFrame()).not.toContain("graph");
    await empty.renderer.destroy();
  });
});

describe("GraphGroupView", () => {
  test("列表含 waiting on；选中行以 > 开头", async () => {
    const setup = await testRender(
      <GraphGroupView
        snapshot={liveSnap}
        selectedId="write"
        detail={false}
        cols={60}
        rows={16}
      />,
      { width: 60, height: 16 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("waiting on write");
    expect(frame).toContain("> * write");
    await setup.renderer.destroy();
  });

  test("详情展示 last 与耗时", async () => {
    const setup = await testRender(
      <GraphGroupView
        snapshot={liveSnap}
        selectedId="research"
        detail={true}
        cols={40}
        rows={8}
      />,
      { width: 40, height: 8 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("node research");
    expect(frame).toContain("FACT");
    expect(frame).toContain("800ms");
    await setup.renderer.destroy();
  });
});
