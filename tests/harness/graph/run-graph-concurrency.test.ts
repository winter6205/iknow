/**
 * Concurrent handler calls on one conversationId — honest pin of the
 * serialisation contract (ADR-0065).
 *
 * **What this test pins (and deliberately does not pin)**:
 *
 * The production serialisation guarantee is not inside the handler but in the
 * ACI executor's concurrency waves (`run_graph` declares
 * `isConcurrencySafe: false`, and `concurrency-waves.ts` splits unsafe calls
 * into their own wave — already covered by
 * `tests/harness/aci/aci-executor-parallel.test.ts`). The bare handler has **no
 * mutex**; this test pins the real consequences:
 *
 *   1. While call1 runs (child unsettled), call2 submits new nodes → call2
 *      does **not** wait for call1 and spawns immediately (the ledger it reads
 *      is the pre-segment-1 empty state: no frozen conflict for b, no failed
 *      dep, so merge passes it);
 *   2. Each call freezes only its own nodes after its own settle (a by call1,
 *      b by call2); the two segments' freezes never overwrite each other;
 *   3. Once both segments settle, the ledger reflects both — it stays
 *      consistent under any call order (the last freeze keeps each segment's
 *      terminal state; with disjoint ids there is no write-back race).
 *
 * If a handler-level serialisation (per-conversation queue) is added later,
 * assertion 1 will fail — rewrite this test to pin the new contract then,
 * rather than loosening the assertion.
 */
import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import {
  makeManager,
  settle,
  ok,
  waitForChildren,
  parseCondensed,
  type FakeChild,
} from "./_fake-manager.ts";

const CONV = "conv-concurrent";

/** Identify a child by its task text (spawn order across calls is not event-loop guaranteed). */
function childByTask(children: FakeChild[], taskMarker: string): FakeChild {
  const hit = children.find((c) => c.written.join("").includes(taskMarker));
  expect(hit, `no child with task marker "${taskMarker}"`).toBeDefined();
  return hit!;
}

describe("run_graph 并发调用同一 conversationId（裸 handler 无 mutex 的诚实钉子）", () => {
  it("call1 在跑时 call2 提交 b → 不等待、立即 spawn；各自 settle 后账本同时反映两段", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // call1: submit a, leave the child **unsettled** — the graph is in flight.
    const call1 = tool.handler(
      { nodes: [{ id: "a", task: "task-alpha" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    expect(children).toHaveLength(1);
    // call1 hasn't settled → a not frozen yet (freeze only after its own settle).
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(false);

    // call2: same conversationId, submit b. The bare handler does not block on
    // call1 — the ledger it reads is the pre-segment-1 empty state (no
    // conflict for b), so it spawns as usual.
    const call2 = tool.handler(
      { nodes: [{ id: "b", task: "task-beta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);

    // b's task passes through verbatim — the ledger call2's merge sees has no
    // frozen-done output to fold in (segment-1 unsettled), so nothing is
    // written into b's task.
    const bChild = childByTask(children, "task-beta");
    expect(bChild.written.join("")).not.toContain("ALPHA-OUT");

    // Settle call1's child → call1 converges → a freezes (with its output).
    settle(childByTask(children, "task-alpha"), ok("ALPHA-OUT"));
    const out1 = parseCondensed(await call1);
    expect(out1.nodes).toEqual([
      { id: "a", status: "done", output: "ALPHA-OUT" },
    ]);
    // b still unsettled → b unfrozen; a frozen — each segment's freeze follows
    // only its own settle.
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);
    expect(host.ledgerFor(CONV).isFrozen("b")).toBe(false);

    // Settle call2's child → call2 converges → b freezes. Both segments'
    // freezes converge; the ledger reflects both, ordered by first freeze.
    settle(bChild, ok("BETA-OUT"));
    const out2 = parseCondensed(await call2);
    expect(out2.nodes).toEqual([
      { id: "b", status: "done", output: "BETA-OUT" },
    ]);

    const ledger = host.ledgerFor(CONV);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
    expect(ledger.outputOf("a")).toBe("ALPHA-OUT");
    expect(ledger.outputOf("b")).toBe("BETA-OUT");
    await manager.shutdown();
  }, 15_000);
});
