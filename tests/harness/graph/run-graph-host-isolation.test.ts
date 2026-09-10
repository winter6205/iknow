/**
 * live-graph-phase1 — handler 级 host 隔离 / 匿名账本路径边界。
 *
 * 覆盖 host 在 handler 入口的两个真实边界（host 单元层在
 * `tests/harness/graph/live-graph-ledger.test.ts` 覆盖，但 handler
 * 在 `mergeResidual` / `ensure` / `freezeResults` 路径上的接线
 * 是单独的契约——本文件只补真缺口的接线，源代码零改动）：
 *
 *   1. **跨会话隔离**：同一 host 同时挂两个 conversationId，冻结互不可见。
 *   2. **`conversationId === undefined` 落到匿名账本**：stub / 直调路径
 *      handler 仍冻结，冻结集合与其它会话互不污染（host 层 `size()` 不
 *      计入匿名，但实际冻结仍生效）。
 *   3. **缺 `nodes` 根字段**：handler typed 拒、零 spawn（与「空 nodes」
 *      「未知节点」同一 EXIT 类别，但走的是根字段缺失而非根字段名错）。
 *
 * 走真 `SubAgentManager`（fake spawn + 假 child），与
 * `run-graph-ledger.test.ts` 同模式。
 */

import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { makeManager, settle, ok, waitForChildren } from "./_fake-manager.ts";

const CONV_A = "conv-A-isolation";
const CONV_B = "conv-B-isolation";

describe("run_graph handler：host 跨会话隔离", () => {
  it("同一 host 上两个 conversationId 的冻结互不污染（handler 级接线）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // conv-A 上冻结 a
    const aPending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV_A }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await aPending;

    // conv-B 上冻结 b —— 共享 host 但不共享账本
    const bPending = tool.handler(
      { nodes: [{ id: "b", task: "tb" }] },
      { conversationId: CONV_B }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B-OUT"));
    await bPending;

    expect(host.size()).toBe(2);
    const aLedger = host.ledgerFor(CONV_A);
    const bLedger = host.ledgerFor(CONV_B);
    expect(aLedger.isFrozen("a")).toBe(true);
    expect(aLedger.isFrozen("b")).toBe(false);
    expect(bLedger.isFrozen("b")).toBe(true);
    expect(bLedger.isFrozen("a")).toBe(false);

    // 跨会话再交不冻结 id 不应拒 —— a 在 conv-A 冻结，对 conv-B 不存在。
    // 同 id 在不同会话各自结算，正是隔离的承诺。
    await manager.shutdown();
  });
});

describe("run_graph handler：conversationId undefined 匿名账本", () => {
  it("ctx.conversationId 缺席 → 落到 host 共享匿名账本，冻结生效且不污染其它会话", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 1) 走匿名账本路径（handler 直调 / stub 场景常用）。
    const anonPending = tool.handler(
      { nodes: [{ id: "x", task: "tx" }] }
      // 不传 ctx → conversationId === undefined
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("X-OUT"));
    await anonPending;

    const anon = host.ledgerFor(undefined);
    expect(anon.isFrozen("x")).toBe(true);
    expect(anon.outputOf("x")).toBe("X-OUT");
    // 匿名账本不计入 size。
    expect(host.size()).toBe(0);

    // 2) 同一 id 在不同会话无冻结（隔离）。
    const aPending = tool.handler(
      { nodes: [{ id: "x", task: "tx-again" }] },
      { conversationId: CONV_A }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("X2-OUT"));
    await aPending;
    expect(host.ledgerFor(CONV_A).isFrozen("x")).toBe(true);
    expect(host.size()).toBe(1);

    await manager.shutdown();
  });

  it("缺 nodes 根字段：handler typed 拒绝、零 spawn（根字段缺失 EXIT）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 直调 handler 路径：根字段缺失（非根字段名错、非空数组）。
    await expect(
      tool.handler({} as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({} as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(/non-empty array/i);

    // nodes 显式 undefined 同样按空数组拒。
    await expect(
      tool.handler({ nodes: undefined } as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(/non-empty array/i);

    expect(children).toHaveLength(0);
    // 验证失败绝不创建账本（与 run-graph-ledger.test.ts SC1 一致）。
    expect(host.ledgerFor(CONV_A).exists()).toBe(false);
    await manager.shutdown();
  });
});
