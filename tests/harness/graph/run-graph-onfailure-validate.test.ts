/**
 * `onFailure` failure-edge schema + validation (ADR-0053–ADR-0066).
 *
 * Pinned invariants:
 *   - **Legal failure edge**: the target is among this submission's `nodes`
 *     (pointing at self = a declared single-node re-entry, ADR-0053) → passes
 *     readNodes + validation. Cycles formed only by `onFailure` are legal
 *     (ADR-0058 / ADR-0059: an explicitly declared back edge is accepted;
 *     cycle detection looks at `deps` only). Legal failure edges are
 *     scheduled as normal deps-DAGs; failure-edge execution semantics are
 *     covered by outcome-scheduler / failure-edges tests.
 *   - **Illegal failure edge → typed rejection, zero spawns**:
 *       (a) the target is not among the ids of this submission;
 *       (b) the target is already frozen in the live-graph ledger (done or
 *           failed, frozen across calls; ADR-0060: done never re-runs via a
 *           failure edge);
 *       (c) the value is not a string (array / number — the schema's
 *           `type: "string"` is the primary contract; readNodes is the
 *           direct-call backstop).
 *   - **Validation failure leaves no ledger trace**: rejection paths never
 *     `ensure()` (same category as invalid topology).
 *   - **No regression of earlier rejection rules**: `deps` self-dep and
 *     `deps` cycles are still rejected; DAGs without `onFailure` follow the
 *     same rules as before failure edges existed.
 *
 * Layering (complexity-anti-drift): target validation is centralized in
 * `on-failure.ts`; validateGraph / topo only see `deps` and never bend Kahn
 * for failure edges.
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

const CONV = "conv-p2-t1";

// ── Legal failure edges ────────────────────────────────────────────────

describe("run_graph onFailure 校验：合法失败边通过", () => {
  it("合法 onFailure DAG 正常通过校验并跑完 deps-DAG（T1 中间态：失败边执行语义在 T2）", async () => {
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
    // b waits for a to settle before spawning; settle in order.
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B-OUT"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A-OUT" },
      { id: "b", status: "done", output: "B-OUT" },
    ]);
    await manager.shutdown();
  });

  it("onFailure 指向自己 = 标明的单格再进入，合法（spec Changes / ADR-0053）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      { nodes: [{ id: "a", task: "ta", onFailure: "a" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([{ id: "a", status: "done", output: "A-OUT" }]);
    expect(children).toHaveLength(1);
    await manager.shutdown();
  });

  it("仅因 onFailure 形成的圈合法（ADR-0058/0059：环检测只对 deps）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      {
        nodes: [
          { id: "a", task: "ta", onFailure: "b" },
          { id: "b", task: "tb", onFailure: "a" },
        ],
      },
      { conversationId: CONV }
    );
    // No deps → both nodes spawn concurrently in one wave; settle order free.
    await waitForChildren(children, 2);
    settle(children[0]!, ok("A-OUT"));
    settle(children[1]!, ok("B-OUT"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([
      { id: "a", status: "done", output: "A-OUT" },
      { id: "b", status: "done", output: "B-OUT" },
    ]);
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });
});

// ── Illegal failure edges: typed rejection, zero spawns ────────────────

describe("run_graph onFailure 校验：非法失败边 typed 拒绝、零 spawn", () => {
  it("目标不在本次提交的 ids 里 → typed 拒、零 spawn（SC5）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "zz" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting unknown node "zz"/);
    expect(children).toHaveLength(0);
    // Rejection paths never create a ledger.
    expect(host.ledgerFor(CONV).exists()).toBe(false);
    await manager.shutdown();
  });

  it("目标是账本上已冻结 done 的 id → typed 拒、零 spawn（ADR-0060）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Precondition: x finished and froze in an earlier segment.
    const first = t.handler(
      { nodes: [{ id: "x", task: "tx" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("X-OUT"));
    await first;

    // This segment: onFailure targets the frozen-done x → rejected.
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "x" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting frozen node "x" \(done\)/);
    expect(children).toHaveLength(1);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["x"]);
    // The rejection happens in the second segment — only the first segment
    // ensured the ledger; the rejected second one creates nothing new.
    expect(host.ledgerFor(CONV).exists()).toBe(true);
    await manager.shutdown();
  });

  it("目标是账本上已冻结 failed 的 id → typed 拒、零 spawn（ADR-0060）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const first = t.handler(
      { nodes: [{ id: "x", task: "tx" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("boom"));
    await first;

    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "x" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting frozen node "x" \(failed\)/);
    expect(children).toHaveLength(1);
    await manager.shutdown();
  });

  it.each([
    ["number", 42],
    ["array", ["b"]],
    ["null", null],
  ])(
    "onFailure 为非法值（%s）→ typed 拒、零 spawn，且不留账本痕迹",
    async (_label, bad) => {
      const { manager, children } = makeManager();
      const host = createLiveGraphLedgerHost();
      const t = createRunGraphTool({
        manager,
        ledger: host,
        isEnabled: () => true,
      });
      await expect(
        t.handler(
          { nodes: [{ id: "a", task: "ta", onFailure: bad }] },
          { conversationId: CONV }
        )
      ).rejects.toThrow(ToolExecutionError);
      await expect(
        t.handler(
          { nodes: [{ id: "a", task: "ta", onFailure: bad }] },
          { conversationId: CONV }
        )
      ).rejects.toThrow(/non-string/);
      expect(children).toHaveLength(0);
      // Validation-failure paths never create a ledger.
      expect(host.ledgerFor(CONV).exists()).toBe(false);
      await manager.shutdown();
    }
  );

  it('onFailure: ""（空串）→ 走 unknown-target 拒绝分支（空串不在本批 ids）', async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting unknown node ""/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it('onFailure: " "（纯空白）→ unknown-target 分支（空白 id 同样不在本批 ids）', async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: " " }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting unknown node " "/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("校验优先级：frozen 重交拒绝先于 onFailure 校验（mergeResidual 的 frozen 拒胜出）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Precondition: x finished as done and froze in an earlier segment.
    const first = t.handler(
      { nodes: [{ id: "x", task: "tx" }] },
      {
        conversationId: CONV,
      }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("X-OUT"));
    await first;

    // This segment: resubmit frozen x with an illegal onFailure — both rejection
    // kinds apply. The frozen check (mergeResidual → resolveResidualSubgraph)
    // runs before the failure-edge check (validateOnFailureEdges) in the
    // handler, so `frozen id(s) cannot be re-run` wins over
    // `onFailure targeting frozen node`. This pins which message deterministically
    // wins, so a future reordering cannot make one rejection report two texts.
    await expect(
      t.handler(
        {
          nodes: [
            { id: "a", task: "ta", onFailure: "x" },
            { id: "x", task: "tx" },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen id\(s\) cannot be re-run/);
    expect(children).toHaveLength(1); // zero new spawns
    // Self-frozen variant: onFailure targets self and self is already frozen — same precedence.
    await expect(
      t.handler(
        { nodes: [{ id: "x", task: "tx", onFailure: "x" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen id\(s\) cannot be re-run/);
    expect(children).toHaveLength(1);
    await manager.shutdown();
  });

  it("onFailure 不能洗白 deps 环：纯 deps 环上叠加合法 onFailure → 仍 topo cycle 拒、零 spawn（ADR-0059）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    // a deps[b] with onFailure:b (target in this batch — alone a legal failure
    // edge); b deps[a] — at the deps level a↔b forms a cycle. Cycle detection
    // only looks at deps; failure edges are no Kahn exemption (ADR-0059: an
    // undeclared back edge does not count — a deps cycle must become a DAG via
    // deps itself, onFailure never changes topology).
    await expect(
      t.handler(
        {
          nodes: [
            { id: "a", task: "ta", deps: ["b"], onFailure: "b" },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/cycle/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("节点带声明面之外的属性（例 retry）→ readNodes unknown property 拒、零 spawn（SC5 第二属性）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", retry: 2 }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/unknown property `retry`/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });
});

// ── No regression of the pre-failure-edge rejection rules ──────────────

describe("run_graph onFailure 校验：阶段 1 拒绝规则不回退", () => {
  it("deps 自依赖仍拒（带 onFailure 的提交里同样拒）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", deps: ["a"], onFailure: "a" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", deps: ["a"], onFailure: "a" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/depends on itself/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });

  it("仅 deps 成环（无 onFailure 标明）仍拒（ADR-0059：未标圈拒）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        {
          nodes: [
            { id: "a", task: "ta", deps: ["b"] },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/cycle/);
    expect(children).toHaveLength(0);
    await manager.shutdown();
  });
});
