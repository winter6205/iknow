/**
 * Residual-subgraph merge + per-id freezing (ADR-0050).
 *
 * Uses a real `SubAgentManager` (fake spawn + fake child, same pattern as
 * run-graph-ledger.test.ts — mocking the manager would mock away exactly
 * "real spawn / zero spawns / output flowing along edges"). Coverage:
 *
 *   - After A is done, a second segment submits only B (deps: [A], A
 *     omitted) → the host does not rerun A, B really spawns and its task
 *     text receives A's ledger output; mixed submissions (a dep pointing at
 *     both a ledger frozen-done node and a new node in this segment) get
 *     both outputs; resubmitting `id: A` → typed rejection, zero spawns.
 *   - Failed ids also freeze: resubmitting a failed id → typed rejection,
 *     zero spawns (the whole segment is rejected, so new nodes in it never
 *     spawn); a dep on a frozen-failed id → typed rejection (retry after
 *     failure requires a new id).
 *   - An id skipped by upstream failure may re-spawn in a later residual
 *     subgraph, and its downstream still receives its output.
 *   - ADR-0066 regression: a dep on an unknown, unfrozen id is still
 *     rejected as unknown-dep with zero spawns (merge semantics must never
 *     swallow unknown ids).
 *   - ADR-0065 serialisation contract: `aci.isConcurrencySafe === false` is
 *     pinned — the ACI executor's single-flight wave makes a second
 *     run_graph in the same session wait for the first to settle.
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

const CONV = "conv-t2";

// ── Residual subgraph: submit B after A is done ────────────────────────

describe("run_graph 剩余子图合并：SC5", () => {
  it("A done 后只交 B（deps: [A]，A 省略）→ A 不重跑、B 真 spawn 且 task 接到 A 的账本产出", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Segment 1: A done with output "A-OUTPUT".
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUTPUT"));
    const firstOut = parse(await first);
    expect(firstOut.nodes).toEqual([
      { id: "a", status: "done", output: "A-OUTPUT" },
    ]);

    // Segment 2: only B, whose deps name A — absent from this submission, so
    // the ledger must satisfy it. manager / host persist across segments of one
    // conversation; the children array accumulates.
    const childrenBefore = children.length;
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb", deps: ["a"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, childrenBefore + 1);
    // No new spawn for A: the one extra child is B, not A rerun.
    expect(children).toHaveLength(childrenBefore + 1);
    const bPayload = children[childrenBefore]!.written.join("");
    // Output flows along edges in the live-graph sense: A's ledger output must appear in B's task.
    expect(bPayload).toContain('"task":"tb');
    expect(bPayload).toContain("A-OUTPUT");
    settle(children[childrenBefore]!, ok("B-OUT"));

    const secondOut = parse(await second);
    // The condensed result covers only this submission's nodes; B's residual
    // deps are dropped at merge time → wave 0.
    expect(secondOut.waveCount).toBe(1);
    expect(secondOut.nodes).toEqual([
      { id: "b", status: "done", output: "B-OUT" },
    ]);

    const ledger = host.ledgerFor(CONV);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
    await manager.shutdown();
  });

  it("混合剩余子图：dep 同时指向 frozen-done（账本）与本次提交节点 → 两边产出都进 task", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Segment 1: A done.
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUTPUT"));
    await first;

    // Segment 2: c (root) + b (deps: [a, c]) — a comes from the ledger, c from this submission.
    const second = tool.handler(
      {
        nodes: [
          { id: "c", task: "tc" },
          { id: "b", task: "tb", deps: ["a", "c"] },
        ],
      },
      { conversationId: CONV }
    );
    // wave 0 is c only (b's remaining dep is [c], so b must wait).
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);
    settle(children[1]!, ok("C-OUT"));
    // wave 1 runs b.
    await waitForChildren(children, 3);
    const bPayload = children[2]!.written.join("");
    expect(bPayload).toContain("A-OUTPUT");
    expect(bPayload).toContain("C-OUT");
    settle(children[2]!, ok("B-OUT"));

    const out = parse(await second);
    expect(out.waveCount).toBe(2);
    expect(out.nodes).toEqual([
      { id: "c", status: "done", output: "C-OUT" },
      { id: "b", status: "done", output: "B-OUT" },
    ]);
    await manager.shutdown();
  });

  it("再交 id: A（A 已 done 冻结）→ typed 拒绝、零新 spawn（SC5 末句）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUTPUT"));
    await first;

    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen/);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });
});

// ── Failed ids also freeze ─────────────────────────────────────────────

describe("run_graph 剩余子图合并：SC6 失败也冻", () => {
  it("failed id 再交（与同段新节点一起）→ 整段 typed 拒绝、零 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Segment 1: boom fails (and freezes).
    const first = tool.handler(
      { nodes: [{ id: "boom", task: "will fail" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await first;
    expect(host.ledgerFor(CONV).isFrozen("boom")).toBe(true);

    // Segment 2: boom retry plus innocent new node "fresh" in one submission →
    // the whole segment is rejected (zero spawns; "fresh" never launches either).
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        {
          nodes: [
            { id: "boom", task: "retry" },
            { id: "fresh", task: "innocent" },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        {
          nodes: [
            { id: "boom", task: "retry" },
            { id: "fresh", task: "innocent" },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen.*boom/s);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });

  it("dep 指向 frozen-failed id → typed 拒绝、零 spawn（阶段 1 失败再试 = 新 id，spec ASSUMPTIONS #3）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const first = tool.handler(
      { nodes: [{ id: "boom", task: "will fail" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await first;

    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "b2", task: "tb2", deps: ["boom"] }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        { nodes: [{ id: "b2", task: "tb2", deps: ["boom"] }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/failed node "boom"/);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });
});

// ── Skipped ids stay unfrozen ──────────────────────────────────────────

describe("run_graph 剩余子图合并：SC7 skipped 未冻", () => {
  it("skipped id 出现在后续剩余子图 → 真 spawn，其下游接到它的产出", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Segment 1: boom fails → after (deps: [boom]) is skipped (not frozen).
    const first = tool.handler(
      {
        nodes: [
          { id: "boom", task: "will fail" },
          { id: "after", task: "needs boom", deps: ["boom"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    const firstOut = parse(await first);
    expect(firstOut.nodes).toContainEqual({
      id: "after",
      status: "skipped",
      reason: 'upstream node "boom" did not complete',
    });
    expect(host.ledgerFor(CONV).isFrozen("after")).toBe(false);

    // Segment 2: after (skipped, unfrozen → resubmittable) + tail (deps: [after]) → both really spawn.
    const second = tool.handler(
      {
        nodes: [
          { id: "after", task: "retry after" },
          { id: "tail", task: "tail task", deps: ["after"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    // Segment 1's single child was boom; this segment's wave 0 is after (no remaining deps).
    expect(children).toHaveLength(2);
    settle(children[1]!, ok("AFTER-OUT"));
    await waitForChildren(children, 3);
    const tailPayload = children[2]!.written.join("");
    expect(tailPayload).toContain("AFTER-OUT");
    settle(children[2]!, ok("TAIL-OUT"));

    const out = parse(await second);
    expect(out.nodes).toEqual([
      { id: "after", status: "done", output: "AFTER-OUT" },
      { id: "tail", status: "done", output: "TAIL-OUT" },
    ]);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("after")).toBe(true);
    expect(ledger.isFrozen("tail")).toBe(true);
    await manager.shutdown();
  });
});

// ── ADR-0066 regression + serialisation contract ───────────────────────

describe("run_graph 剩余子图合并：校验边界不因合并放松", () => {
  it("dep 指向未知且未冻结的 id → 仍 unknown-dep typed 拒、零 spawn（ADR-0066 / spec SC12）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Create the ledger first (a done).
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;

    // With a live graph already present, resubmit a ghost dep — merge
    // semantics must never treat it as "satisfied by the ledger".
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "b", task: "tb", deps: ["ghost"] }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        { nodes: [{ id: "b", task: "tb", deps: ["ghost"] }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/unknown node "ghost"/);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });

  it("ADR-0065 串行契约：run_graph aci.isConcurrencySafe === false", () => {
    const { manager } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });
    expect(tool.aci.isConcurrencySafe).toBe(false);
    expect(tool.aci.timeoutTier).toBe("unbounded");
    expect(tool.aci.interruptBehavior).toBe("cancel");
  });
});
