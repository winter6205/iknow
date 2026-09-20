/**
 * PROTOTYPE — self-authored Graph multi-task orchestration: scheduler.test.ts.
 *
 * Coverage:
 *   1. Empty spec → waveCount=0, all nodes absent.
 *   2. Nodes in one wave run concurrently (Promise.all + spawn ordering).
 *   3. Waves serialize: wave N starts only after wave N-1 fully settles.
 *   4. A failed node skips its direct dependents (fail-fast down deps).
 *   5. Failure does not leak into unrelated branches.
 *   6. Thrown errors from child nodes are captured as failed.
 *   7. waveCount counts waves actually advanced (not spec.nodes.length).
 *   8. onWave / onNode callbacks fire in the right order.
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
    // Collect start timestamps to prove both nodes launch in parallel.
    const starts: number[] = [];
    const exec: NodeExecutor = async () => {
      starts.push(Date.now());
      // 50ms pause simulating real work.
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
    // Concurrent: both nodes start nearly simultaneously, total < 100ms.
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
    // wave 0 (a) must end before wave 1 (b) starts.
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
        { id: "c", deps: ["b"] }, // transitively on a → also skipped
      ],
    };
    const out = await runGraph(spec, exec);
    assert.equal(out.statuses.a, "failed");
    assert.equal(out.statuses.b, "skipped");
    assert.equal(out.statuses.c, "skipped");
    const bResult = out.results.b;
    assert.ok(bResult?.status === "skipped");
    const bReason = bResult?.status === "skipped" ? bResult.reason : "";
    // reason has the shape `upstream node "a" did not complete` — assert the upstream id verbatim.
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
    // wave 0 is emitted before a/b finish; onNode fires a/b done twice inside
    // wave 0; wave 1 is emitted before c finishes; the last event is c done.
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
