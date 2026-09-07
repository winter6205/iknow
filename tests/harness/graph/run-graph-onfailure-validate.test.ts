/**
 * live-graph-phase2 T1 — `onFailure` 失败边 schema + 校验（spec SC4–SC5 /
 * Changes 段 / ADR-0053–0066）。
 *
 * 钉住的不变式：
 *   - **合法失败边**：目标在本次 `nodes` 里（含指向自己 = 标明的单格再进
 *     入，ADR-0053 / spec Changes）→ 通过 readNodes + 校验；仅因
 *     `onFailure` 形成的圈合法（ADR-0058 / 0059：回边显式标明即认，
 *     环检测只对 `deps`）。T1 中间态：合法失败边按 deps-DAG 正常调度，
 *     失败边执行语义在 T2 落地。
 *   - **非法失败边 → typed 拒、零 spawn**：
 *       (a) 目标不在本次提交的 ids 里（SC5 / spec Changes「目标必须是
 *           本次 nodes 的某个 id」）；
 *       (b) 目标在活图账本上已冻结（done 或 failed，跨调用冻结，
 *           ADR-0060：done 永不因失败边再跑）；
 *       (c) 值非 string（数组 / 数字 —— SC5「两条失败边」在 JSON 对象
 *           里只能以非法值形态出现；schema `type: "string"` 是主合同，
 *           readNodes 是直调路径的兜底闸）。
 *   - **校验失败不留账本痕迹**：SC1 / ASSUMPTIONS #4 —— 拒绝路径绝不
 *     `ensure()`（与拓扑非法同类别）。
 *   - **阶段 1 行为不回退**（SC9）：`deps` 自依赖 / `deps` 成环仍拒；
 *     不带 `onFailure` 的 DAG 拒绝规则与阶段 1 逐条相同。
 *
 * 分层（complexity-anti-drift）：目标校验在 `on-failure.ts` 单点，
 * validateGraph / topo 只认 `deps`，不因失败边改 Kahn。
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

// ── 合法失败边 ────────────────────────────────────────────────────────

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
    // b 要等 a settle 后才 spawn，顺序 settle
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
    // 无 deps → 两节点同波并发 spawn，settle 顺序任意
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

// ── 非法失败边：typed 拒、零 spawn ────────────────────────────────────

describe("run_graph onFailure 校验：非法失败边 typed 拒绝、零 spawn", () => {
  it("目标不在本次提交的 ids 里 → typed 拒、零 spawn（SC5）", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "zz" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting unknown node "zz"/);
    expect(children).toHaveLength(0);
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

    // 前置：x 在前一段跑完并冻结
    const first = t.handler(
      { nodes: [{ id: "x", task: "tx" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("X-OUT"));
    await first;

    // 本段：onFailure 指向已冻结 done 的 x → 拒
    await expect(
      t.handler(
        { nodes: [{ id: "a", task: "ta", onFailure: "x" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/onFailure targeting frozen node "x" \(done\)/);
    expect(children).toHaveLength(1);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual(["x"]);
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
      // 校验失败路径绝不建账本（SC1 / ASSUMPTIONS #4）
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

// ── 阶段 1 不回退（SC9） ──────────────────────────────────────────────

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
