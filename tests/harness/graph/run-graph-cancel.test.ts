/**
 * Cancellation preserves already-done nodes.
 *
 * Uses the real `SubAgentManager` (fake spawn + fake child, same pattern as
 * run-graph-residual.test.ts). Covers:
 *
 *   - a→b chain aborted after a is done → a frozen (with output, `outputOf`
 *     readable), b not frozen (the abort-induced failed is only a cancel
 *     symptom; the whole segment can be resubmitted); the handler rejects with
 *     a typed cancellation and never condenses a half graph as success; then
 *     submitting only b (deps: [a]) → b really spawns, reads a's ledger output, succeeds.
 *   - boundary: signal already aborted before spawn → zero freezes, zero spawns, typed cancel.
 *   - regression pin: in non-cancel normal settles, failed still freezes (only the abort path changed; normal failure-freeze semantics unchanged).
 */

import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import {
  makeManager,
  settle,
  ok,
  fail,
  waitForChildren,
} from "./_fake-manager.ts";

const CONV = "conv-t3";

// ── abort after a is done → a frozen, b unfrozen, b resubmittable ───────

describe("run_graph 取消保留已 done：SC8", () => {
  it("a→b 链 abort：a 冻结含产出、b 不冻；typed 取消拒绝；随后只交 b 真 spawn 并接到 a 的产出", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    const controller = new AbortController();
    // Determinism anchor: the graph_progress event fired by the scheduler's
    // onNode(a, done) is ground truth for "runGraph has recorded a as done" —
    // abort must wait for it, otherwise during waitFor's 25ms polling gap the
    // abort would also mark a failed (cancel symptom) and the test would no
    // longer cover "cancel after a truly done".
    const events: Array<{
      type: string;
      snapshot?: { nodes: Array<{ id: string; status: string }> };
    }> = [];
    let wakeDoneA: () => void = () => {};
    const doneA = new Promise<void>((resolve) => {
      wakeDoneA = resolve;
    });
    const noteDoneA = (): void => {
      for (const e of events) {
        if (
          e.type === "graph_progress" &&
          e.snapshot?.nodes.some((n) => n.id === "a" && n.status === "done")
        ) {
          wakeDoneA();
          return;
        }
      }
    };

    const pending = tool.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      },
      {
        signal: controller.signal,
        conversationId: CONV,
        onStream: (e) => {
          events.push(e as never);
          noteDoneA();
        },
      }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUTPUT"));
    await doneA;
    // a is recorded done by the scheduler, b's wave hasn't started — cancel now.
    // b's outcome, whether via the pre-spawn check (failed) or waitFor abort,
    // must not freeze as done.
    controller.abort();

    // Handler typed cancellation — a half graph is never condensed as success.
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);

    // The done node a is frozen with readable output; b is not frozen.
    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe("A-OUTPUT");
    expect(ledger.isFrozen("b")).toBe(false);

    // Residual subgraph: submit only b (deps: [a]; a's done is satisfied from the
    // ledger) → b really spawns and its task text carries a's output — proving b
    // is resubmittable and a's output flows along the edge.
    const childrenBefore = children.length;
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb", deps: ["a"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, childrenBefore + 1);
    // b is the only new spawn in this segment: a never replays (ledger-frozen),
    // and b was not mis-frozen by the abort.
    expect(children).toHaveLength(childrenBefore + 1);
    const bPayload = children[childrenBefore]!.written.join("");
    expect(bPayload).toContain('"task":"tb');
    expect(bPayload).toContain("A-OUTPUT");
    settle(children[childrenBefore]!, ok("B-OUT"));
    const secondOut = JSON.parse((await second) as string) as {
      nodes: Array<{ id: string; status: string; output?: string }>;
    };
    expect(secondOut.nodes).toEqual([
      { id: "b", status: "done", output: "B-OUT" },
    ]);
    expect(ledger.isFrozen("b")).toBe(true);
    await manager.shutdown();
  }, 15_000);

  it("signal 在 spawn 前已 aborted：零冻结、零 spawn、typed 取消", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    const controller = new AbortController();
    controller.abort(); // already cancelled before the handler runs

    await expect(
      tool.handler(
        {
          nodes: [
            { id: "a", task: "ta" },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        { signal: controller.signal, conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        {
          nodes: [
            { id: "a", task: "ta" },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        { signal: controller.signal, conversationId: CONV }
      )
    ).rejects.toThrow(/cancel/i);

    expect(children).toHaveLength(0);
    // Ledger exists (ensure ran after validation passed) but no id is frozen — all resubmittable.
    expect(host.ledgerFor(CONV).exists()).toBe(true);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual([]);
    await manager.shutdown();
  });
});

// ── Caller-side cancellation over failure-edge graphs ─────────────────

describe("run_graph 取消 × 失败边再进入（phase2 边界）", () => {
  it("self-onFailure 第 2 次再进入 settle ok 之后 abort：typed cancel 拒、a 冻结 done（末次结局胜出）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    const controller = new AbortController();
    // The onNode callback is not directly observable (the handler wires it to
    // progress internally) — use the graph_progress event stream as the anchor
    // for "a's second entry has settled ok" (same pattern as the test above).
    const events: Array<{
      type: string;
      snapshot?: { nodes: Array<{ id: string; status: string }> };
    }> = [];
    let wakeDoneA: () => void = () => {};
    const doneA = new Promise<void>((resolve) => {
      wakeDoneA = resolve;
    });
    const noteDoneA = (): void => {
      for (const e of events) {
        if (
          e.type === "graph_progress" &&
          e.snapshot?.nodes.some((n) => n.id === "a" && n.status === "done")
        ) {
          wakeDoneA();
          return;
        }
      }
    };

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta", onFailure: "a" }] },
      {
        signal: controller.signal,
        conversationId: CONV,
        onStream: (e) => {
          events.push(e as never);
          noteDoneA();
        },
      }
    );
    // First entry fails → the self failure edge kicks a(2).
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // a(2) settles ok — "done" for a shows up in graph_progress (the last
    // onNode fire). The abort lands only after a(2) has settled.
    await waitForChildren(children, 2);
    settle(children[1]!, ok("A-RETRY"));
    await doneA;
    controller.abort();

    // The handler rejects with a typed cancel (after abort, no-new-entries
    // makes the scheduler converge).
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);
    // Cancel rule "freeze done only": a's last outcome is done (last wins) →
    // done is frozen and readable — cancellation never swallows a real result.
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe("A-RETRY");
    await manager.shutdown();
  }, 15_000);

  it("abort 打在再进入仍 failed 时：a 不冻 done（cancel 规则），可下段再交", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    const controller = new AbortController();

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta", onFailure: "a" }] },
      { signal: controller.signal, conversationId: CONV }
    );
    // First entry fails (crash).
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // The self failure edge kicks a(2) (re-entry wave); abort lands **before** a(2) settles.
    await waitForChildren(children, 2);
    controller.abort();
    // a(2) still settles by its real outcome — failed (the cancel symptom).
    settle(children[1]!, fail("still-crashed"));

    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);
    // Cancel rule: an abort-symptom "failed" is never frozen — a stays
    // unfrozen and may be resubmitted in the next segment.
    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("a")).toBe(false);
    await manager.shutdown();
  }, 15_000);
});

describe("run_graph 正常 settle 冻结语义不变：SC6 回归", () => {
  it("无 abort 的正常失败 → failed 仍冻结（T3 只改取消路径）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "boom", task: "will fail" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    children[0]!.stdout.write(
      JSON.stringify({
        status: "failed",
        summary: "boom",
        reason: "crashed",
        result: "",
      }) + "\n"
    );
    children[0]!.emit("exit", 0, null);
    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("boom")).toBe(true);
    expect(ledger.statusOf("boom")).toBe("failed");
    await manager.shutdown();
  });
});
