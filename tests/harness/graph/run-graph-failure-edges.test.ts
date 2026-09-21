/**
 * Handler-level failure-edge driving (ADR-0054 / ADR-0055).
 *
 * Division of labor with outcome-scheduler.test.ts: this group uses the real
 * `SubAgentManager` + fake child (same pattern as run-graph-executor.test.ts)
 * and verifies:
 *   - handler really drives the executor with `onFailure` as event source;
 *     envelope failed/done decides whether a failure edge starts; skipped
 *     nodes never trigger failure edges.
 *   - the same id enters the executor twice via a failure edge — `children`
 *     count exceeds spec.nodes count (a wire-level repeat of the stub-test proof).
 *   - the handler call is blocking; `await tool.handler` returns only after
 *     failure rewalk completes — no wait:false.
 *   - mid-run violation: when the target is already done this segment, the
 *     handler rejects typed and partial done results still enter the ledger
 *     (phase-1 freeze semantics).
 *   - regression pin: graphs without failure edges still take plain `runGraph` Kahn.
 *
 * These tests do not re-implement the outcome-scheduler algorithm — they walk
 * the two `runGraphWithFailureEdges` paths inside the handler via the real manager.
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
  parseCondensed as parse,
} from "./_fake-manager.ts";

const CONV = "conv-p2-t2";

describe("run_graph failure edges — SC1 失败走开格（未冻）", () => {
  it("self-onFailure：首次 failed → 同 id 再跑 → 整段 handler 阻塞返回", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      { nodes: [{ id: "a", task: "ta", onFailure: "a" }] },
      { conversationId: CONV }
    );
    // first entry fails
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // the self-edge triggers a second entry under the same id
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);
    settle(children[1]!, ok("A-RETRY"));
    // whole call blocks — the result arrives only after awaiting the handler
    const out = parse(await pending);
    expect(out.nodes).toEqual([{ id: "a", status: "done", output: "A-RETRY" }]);
    await manager.shutdown();
  });

  it("deps-on-failed-target：起点 failed → deps 指向它的终点首次进入", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "c", task: "tc", onFailure: "d" },
          { id: "d", task: "td", deps: ["c"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // d is started by the failure edge after c failed (its deps path was
    // replaced by c's failure)
    await waitForChildren(children, 2);
    settle(children[1]!, ok("D-OK"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "c", status: "failed", error: expect.stringContaining("crashed") },
      { id: "d", status: "done", output: "D-OK" },
    ]);
    await manager.shutdown();
  });

  it("起点 done → 不走失败边：终点只经 deps 进入一次（无多余 spawn）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "a", task: "ta", onFailure: "b" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OK"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B-OK"));
    const out = parse(await pending);
    expect(children).toHaveLength(2);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A-OK" },
      { id: "b", status: "done", output: "B-OK" },
    ]);
    await manager.shutdown();
  });
});

describe("run_graph failure edges — SC3 skipped 不走失败边", () => {
  it("被 skipped 的节点不触发失败边", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "b", task: "tb" },
          { id: "c", task: "tc", deps: ["b"], onFailure: "d" },
          { id: "d", task: "td", deps: ["c"] },
        ],
      },
      { conversationId: CONV }
    );
    // wave 0: b runs for real
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // c fail-fast skips via deps (never enters the executor) and triggers no
    // failure edge; d skips along with c
    await new Promise((r) => setTimeout(r, 5));
    expect(children).toHaveLength(1);
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "b", status: "failed", error: expect.stringContaining("crashed") },
      { id: "c", status: "skipped", reason: expect.stringContaining("b") },
      { id: "d", status: "skipped", reason: expect.stringContaining("c") },
    ]);
    await manager.shutdown();
  });
});

describe("run_graph failure edges — SC6 跨 id 再跑", () => {
  it("a 首 failed、被 b 的失败边再进：handler 共 spawn 三个 child", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", onFailure: "a" },
        ],
      },
      { conversationId: CONV }
    );
    // wave 0: a and b run concurrently
    await waitForChildren(children, 2);
    settle(children[0]!, fail("crashed"));
    settle(children[1]!, fail("crashed"));
    // a's own failure edge never fires (a has no onFailure);
    // b's failure edge re-runs a (a is still unfrozen at this point)
    await waitForChildren(children, 3);
    expect(children).toHaveLength(3);
    settle(children[2]!, ok("A-RETRY"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A-RETRY" },
      { id: "b", status: "failed", error: expect.stringContaining("crashed") },
    ]);
    await manager.shutdown();
  });
});

describe("run_graph failure edges — mid-run violation", () => {
  it("终点本段已 done → typed 拒、保留 done 进账本、零额外 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // wave 0: b runs and is done (its failure-edge target was not yet defined);
    // a's edge points at b, and b finished done first this segment → a failing
    // must not kick b
    const pending = t.handler(
      {
        nodes: [
          { id: "b", task: "tb" },
          { id: "a", task: "ta", deps: ["b"], onFailure: "b" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("B-OK"));
    await waitForChildren(children, 2);
    settle(children[1]!, fail("crashed"));
    // Rejected with a typed error — partial results are preserved.
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/already done/);
    // b is frozen: its done was written to the ledger at settle, before the
    // violation's typed rejection (freeze happens first)
    const frozen = host.ledgerFor(CONV).frozenIds();
    expect(frozen).toContain("b");
    expect(host.ledgerFor(CONV).statusOf("b")).toBe("done");
    // no third spawn (a done node is never re-run via a failure edge)
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });

  it("violation 波内已落定 done 的同波兄弟也冻结（整波先记录再判违规）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // wave 0 has three root nodes settling b(done) → a(failed) → c(done):
    // a's edge points at b, already done this segment → violation. c is
    // unrelated to the edge but ran to completion in a's wave — every wave
    // outcome must be recorded before a violation may be raised (otherwise c
    // never reaches results, freeze misses it, and the next outer-loop segment
    // would re-spawn a completed c, violating no-replay-of-done).
    const pending = t.handler(
      {
        nodes: [
          { id: "b", task: "tb" },
          { id: "a", task: "ta", onFailure: "b" },
          { id: "c", task: "tc" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 3);
    settle(children[0]!, ok("B-OK"));
    settle(children[1]!, fail("crashed"));
    settle(children[2]!, ok("C-OK"));
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/already done/);
    // The same-wave done sibling c freezes together with trigger point b, and
    // **the real failure start a must freeze as failed too**: wave results are
    // fully written before the violation is raised, and freezeResults reuses
    // the normal settle path (freeze done + genuine failed, not the cancel
    // path's "freeze done only"), so a freezes alongside siblings b/c.
    // Otherwise resubmitting a in the next residual segment would spawn it
    // again, violating no-replay-of-done (freeze semantics: see run-graph-tool.ts freezeResults).
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("a")).toBe("failed");
    expect(ledger.statusOf("b")).toBe("done");
    expect(ledger.statusOf("c")).toBe("done");
    expect(ledger.frozenIds()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    // no redundant spawn (c does not re-run)
    expect(children).toHaveLength(3);
    await manager.shutdown();
  });
});

describe("run_graph failure edges — 账本在调用中被销毁（phase2 边界）", () => {
  it("child 未落定时 host.destroy(CONV)：settle 后不 crash、typed 路径照常返回；freeze 对已销毁账本是静默 no-op", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    // a(self-onFailure) + b: a re-enters via its failure edge on failure, b is
    // an ordinary node. a(1) settles failed first; b's child spawns but stays
    // unsettled — destroy the ledger in that gap (simulating reset / session
    // end racing with run_graph).
    const pending = t.handler(
      {
        nodes: [{ id: "a", task: "ta", onFailure: "a" }],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.exists()).toBe(true);
    // a(1) settles failed → the self failure edge kicks a(2).
    settle(children[0]!, fail("crashed"));
    await waitForChildren(children, 2);
    // Destroy the ledger — the handler closure still holds the ledger
    // reference, but its frozen set and created flag are cleared.
    host.destroy(CONV);
    // a(2) settles ok: after convergence the handler calls freezeResults —
    // on a destroyed ledger (created === false) that is a silent no-op,
    // it must not crash.
    settle(children[1]!, ok("A-RETRY"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([{ id: "a", status: "done", output: "A-RETRY" }]);
    // The ledger stays destroyed: the freeze no-op rebuilt no trace of
    // freezing (ACI serialization is the real concurrency guard; this test
    // pins the defensive boundary "freeze after destroy does not resurrect
    // the ledger", not concurrency semantics themselves).
    expect(host.ledgerFor(CONV).exists()).toBe(false);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual([]);
    await manager.shutdown();
  }, 15_000);
});

describe("run_graph failure edges — abort-frozen 后再指向冻结（phase2 边界）", () => {
  it("第一段 abort 把 a 冻结 done；第二段提交 onFailure:a → typed 拒、零 spawn、账本不变", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    const controller = new AbortController();
    // Determinism anchor: abort only once a shows done in graph_progress —
    // otherwise during waitFor's 25ms polling gap the abort would mark a as
    // cancel-symptom failed (same anchor style as run-graph-cancel.test.ts).
    const events: Array<{
      type: string;
      snapshot?: { nodes: Array<{ id: string; status: string }> };
    }> = [];
    let wakeDoneA: () => void = () => {};
    const doneA = new Promise<void>((resolve) => {
      wakeDoneA = resolve;
    });

    // Segment 1: abort after a finishes done (same pattern as
    // run-graph-cancel.test.ts — a freezes done).
    const first = t.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      {
        signal: controller.signal,
        conversationId: CONV,
        onStream: (e) => {
          events.push(e as never);
          if (
            e.type === "graph_progress" &&
            e.snapshot?.nodes.some((n) => n.id === "a" && n.status === "done")
          ) {
            wakeDoneA();
          }
        },
      }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await doneA;
    controller.abort();
    await expect(first).rejects.toThrow(/cancel/i);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("a")).toBe("done");

    // Second segment: submit r(onFailure: a) where a is a frozen done in the
    // ledger (done never re-runs via a failure edge). Both
    // mergeResidual's frozen-resubmission rejection and the failure edge's
    // frozen-target rejection fire: typed rejection, zero spawns, and the
    // ledger's frozen set stays unchanged.
    await expect(
      t.handler(
        { nodes: [{ id: "r", task: "tr", onFailure: "a" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["a"]);
    await manager.shutdown();
  });
});

describe("run_graph failure edges — 阶段 1 不回退（SC9）", () => {
  it("无 onFailure 的 DAG 仍 Kahn 语义（与阶段 1 同 bytes）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B"));
    const out = parse(await pending);
    expect(out.waveCount).toBe(2);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A" },
      { id: "b", status: "done", output: "B" },
    ]);
    await manager.shutdown();
  });
});
