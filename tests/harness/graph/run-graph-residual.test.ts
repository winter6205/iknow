/**
 * live-graph-phase1 T2 — 剩余子图合并 + 按 id 冻结（spec SC5–SC7 / ADR-0050）。
 *
 * 走真 `SubAgentManager`（fake spawn + 假 child，与 run-graph-ledger.test.ts
 * 同模式 —— 不 mock manager，否则要验的「真 spawn / 零 spawn / 产出沿边流动」
 * 就被 mock 掉）。覆盖：
 *
 *   - SC5：A done 后第二段只交 B（deps: [A]，A 节点省略）→ host 不重跑 A、
 *     B 真 spawn 且 task 文本接到 A 的账本产出；混合提交（dep 同时指向账本
 *     frozen-done 与本次新节点）两边产出都接到；再交 `id: A` → typed 拒、零 spawn。
 *   - SC6：failed id 再交 → typed 拒、零 spawn（整段提交一起拒，连带同段
 *     新节点也不 spawn）；dep 指向 frozen-failed id → typed 拒（阶段 1 失败
 *     再试 = 新 id，spec ASSUMPTIONS #3）。
 *   - SC7：因上游失败被 skipped 的 id 出现在后续剩余子图 → 真 spawn，
 *     其下游还能接到它的产出。
 *   - ADR-0066 回归（spec SC12）：dep 指向未知且未冻结的 id → 仍按
 *     unknown-dep typed 拒、零 spawn（合并语义不得吞掉未知 id）。
 *   - ADR-0065 串行契约：`aci.isConcurrencySafe === false` 钉住 —— 同一会话
 *     第二段 run_graph 由 ACI executor 的单例波次保证等第一段 settle。
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

// ── SC5：剩余子图 —— A done 后只交 B ──────────────────────────────────

describe("run_graph 剩余子图合并：SC5", () => {
  it("A done 后只交 B（deps: [A]，A 省略）→ A 不重跑、B 真 spawn 且 task 接到 A 的账本产出", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 第一段：A done，产出 "A-OUTPUT"
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

    // 第二段：只交 B，deps 指向本次提交里没有的 A —— 必须被账本满足。
    // manager / host 都延续（同一会话第二段），children 数组跨段累计。
    const childrenBefore = children.length;
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb", deps: ["a"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, childrenBefore + 1);
    // host 没有为 A 起新 spawn：新增的 1 个 child 是 B，不是 A 的重演
    expect(children).toHaveLength(childrenBefore + 1);
    const bPayload = children[childrenBefore]!.written.join("");
    // 数据沿边流动的活图版：B 的 task 里必须出现 A 的账本产出
    expect(bPayload).toContain('"task":"tb');
    expect(bPayload).toContain("A-OUTPUT");
    settle(children[childrenBefore]!, ok("B-OUT"));

    const secondOut = parse(await second);
    // 浓缩只含本次提交的节点；B 的剩余 deps 在合并层被剔除 → wave 0
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

    // 第一段：A done
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUTPUT"));
    await first;

    // 第二段：c（根）+ b（deps: [a, c]）—— a 来自账本，c 来自本次提交
    const second = tool.handler(
      {
        nodes: [
          { id: "c", task: "tc" },
          { id: "b", task: "tb", deps: ["a", "c"] },
        ],
      },
      { conversationId: CONV }
    );
    // wave 0 只有 c（b 的剩余 deps 是 [c]，必须等 c）
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);
    settle(children[1]!, ok("C-OUT"));
    // wave 1 跑 b
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

// ── SC6：失败也冻 ─────────────────────────────────────────────────────

describe("run_graph 剩余子图合并：SC6 失败也冻", () => {
  it("failed id 再交（与同段新节点一起）→ 整段 typed 拒绝、零 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 第一段：boom failed（冻结）
    const first = tool.handler(
      { nodes: [{ id: "boom", task: "will fail" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await first;
    expect(host.ledgerFor(CONV).isFrozen("boom")).toBe(true);

    // 第二段：boom 重试 + 无辜新节点 fresh 同段提交 → 整段拒（零 spawn，fresh 也不起）
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

// ── SC7：skipped 未冻 ─────────────────────────────────────────────────

describe("run_graph 剩余子图合并：SC7 skipped 未冻", () => {
  it("skipped id 出现在后续剩余子图 → 真 spawn，其下游接到它的产出", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 第一段：boom failed → after（deps: [boom]）被 skipped（不冻结）
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

    // 第二段：after（skipped 未冻，可再交）+ tail（deps: [after]）→ 都真 spawn
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
    // 第一段的 1 个 child 是 boom；本段 wave 0 是 after（无剩余依赖）
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

// ── ADR-0066 回归 + 串行契约 ──────────────────────────────────────────

describe("run_graph 剩余子图合并：校验边界不因合并放松", () => {
  it("dep 指向未知且未冻结的 id → 仍 unknown-dep typed 拒、零 spawn（ADR-0066 / spec SC12）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 先建账本（a done）
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;

    // 活图已存在后再交 ghost 依赖 —— 合并语义不得把它当「账本满足」
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
