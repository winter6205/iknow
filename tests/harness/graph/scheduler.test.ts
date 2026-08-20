/**
 * PROTOTYPE — Self-written Graph 多任务编排：scheduler.test.ts。
 *
 * 覆盖：
 *   1. 空 spec → waveCount=0, 所有节点 absent。
 *   2. 同 wave 内节点并发执行（Promise.all + spawn ordering）。
 *   3. 跨 wave 串行：wave N 在 wave N-1 全 settled 后才开工。
 *   4. 节点失败 → 其直接依赖者被 skipped（fail-fast 沿 deps 链）。
 *   5. 节点失败不传染无关分支：分支 A 失败不影响分支 B。
 *   6. 子节点 thrown error 被捕获并归为 failed。
 *   7. waveCount 等于实际推进的 wave 数（不是 spec.nodes.length）。
 *   8. onWave / onNode 回调触发顺序正确。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runGraph } from "../../../src/harness/graph/scheduler.ts";
import type {
  GraphNodeResult,
  GraphSpec,
  NodeExecutor,
} from "../../../src/harness/graph/types.ts";

describe("runGraph", () => {
  it("empty spec → waveCount 0", async () => {
    const exec: NodeExecutor = async () => ({
      status: "done",
      output: null,
    });
    const out = await runGraph({ nodes: [] }, exec);
    assert.equal(out.waveCount, 0);
    assert.equal(Object.keys(out.statuses).length, 0);
  });

  it("single node done", async () => {
    const exec: NodeExecutor = async () => ({
      status: "done",
      output: "x",
    });
    const spec: GraphSpec = { nodes: [{ id: "a", deps: [] }] };
    const out = await runGraph(spec, exec);
    assert.equal(out.waveCount, 1);
    assert.equal(out.statuses.a, "done");
    assert.equal(out.results.a?.status, "done");
  });

  it("same-wave nodes run concurrently (Promise.all)", async () => {
    // 收集"开始执行"时间戳，证明两个节点并行启动（间隔 < ~10ms）。
    const starts: number[] = [];
    const exec: NodeExecutor = async () => {
      starts.push(Date.now());
      // 等 50ms 模拟真实工作。
      await new Promise((r) => setTimeout(r, 50));
      return { status: "done", output: "ok" };
    };
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: [] },
      ],
    };
    const t0 = Date.now();
    const out = await runGraph(spec, exec);
    const total = Date.now() - t0;
    assert.equal(starts.length, 2);
    // 并行：两个节点几乎同时开始，整体 < 100ms。
    const gap = Math.abs(starts[0]! - starts[1]!);
    assert.ok(gap < 30, `expected concurrent start, gap=${gap}ms`);
    assert.ok(total < 100, `expected concurrent total <100ms, got ${total}ms`);
    assert.equal(out.statuses.a, "done");
    assert.equal(out.statuses.b, "done");
  });

  it("cross-wave serial: wave N+1 starts only after wave N settles", async () => {
    const order: string[] = [];
    const exec: NodeExecutor = async (id) => {
      order.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${id}`);
      return { status: "done", output: id };
    };
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
      ],
    };
    await runGraph(spec, exec);
    // wave 0 (a) 必须 end 在 wave 1 (b) start 之前。
    const endA = order.indexOf("end:a");
    const startB = order.indexOf("start:b");
    assert.ok(endA >= 0 && startB >= 0);
    assert.ok(endA < startB, `expected end:a before start:b, got ${order}`);
  });

  it("failure → direct dependents skipped (fail-fast along deps chain)", async () => {
    const exec: NodeExecutor = async (id) => {
      if (id === "a") return { status: "failed", error: "boom" };
      return { status: "done", output: id };
    };
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] }, // 传递依赖 a → 也应 skipped
      ],
    };
    const out = await runGraph(spec, exec);
    assert.equal(out.statuses.a, "failed");
    assert.equal(out.statuses.b, "skipped");
    assert.equal(out.statuses.c, "skipped");
    const bResult = out.results.b;
    assert.ok(bResult?.status === "skipped");
    const bReason = bResult?.status === "skipped" ? bResult.reason : "";
    // reason 形如 `upstream node "a" did not complete` —— 字符级断言上游 id。
    assert.match(bReason, /"a" did not complete/);
  });

  it("failure in branch A does not affect independent branch B", async () => {
    const exec: NodeExecutor = async (id) => {
      if (id === "root-a") return { status: "failed", error: "boom-a" };
      if (id === "root-b") return { status: "done", output: "b-ok" };
      return { status: "done", output: id };
    };
    const spec: GraphSpec = {
      nodes: [
        { id: "root-a", deps: [] },
        { id: "leaf-a", deps: ["root-a"] },
        { id: "root-b", deps: [] },
        { id: "leaf-b", deps: ["root-b"] },
      ],
    };
    const out = await runGraph(spec, exec);
    assert.equal(out.statuses["root-a"], "failed");
    assert.equal(out.statuses["leaf-a"], "skipped");
    assert.equal(out.statuses["root-b"], "done");
    assert.equal(out.statuses["leaf-b"], "done");
  });

  it("executor thrown error is captured as failed", async () => {
    const exec: NodeExecutor = async () => {
      throw new Error("executor threw");
    };
    const spec: GraphSpec = { nodes: [{ id: "a", deps: [] }] };
    const out = await runGraph(spec, exec);
    assert.equal(out.statuses.a, "failed");
    const result = out.results.a as GraphNodeResult;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.error, /executor threw/);
    }
  });

  it("onWave / onNode callbacks fire in order", async () => {
    const events: string[] = [];
    const exec: NodeExecutor = async (id) => ({
      status: "done",
      output: id,
    });
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: [] },
        { id: "c", deps: ["a", "b"] },
      ],
    };
    await runGraph(spec, exec, {
      onWave: (w, ids) => {
        events.push(`wave:${w}:${ids.join(",")}`);
      },
      onNode: (r) => {
        events.push(`node:${r.id}:${r.status}`);
      },
    });
    // wave 0 在 a/b 完成前发；onNode 应在 wave 0 内出现两次 a/b done;
    // wave 1 在 c 完成前发；最后一条是 c done。
    assert.equal(events[0], "wave:0:a,b");
    assert.ok(events.includes("node:a:done"));
    assert.ok(events.includes("node:b:done"));
    assert.ok(events.includes("wave:1:c"));
    assert.ok(events.includes("node:c:done"));
    assert.equal(events[events.length - 1], "node:c:done");
  });

  it("invalid spec throws", async () => {
    const exec: NodeExecutor = async () => ({
      status: "done",
      output: null,
    });
    const spec: GraphSpec = { nodes: [{ id: "a", deps: ["missing"] }] };
    await assert.rejects(() => runGraph(spec, exec), /invalid graph/);
  });
});
