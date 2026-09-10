/**
 * live-graph-phase1 M2 — 并发调用同一 conversationId 的 handler 级行为
 * （spec SC10 / ADR-0065 串行契约的诚实钉子）。
 *
 * **这条测试钉什么（以及故意不钉什么）**：
 *
 * 生产里的串行保证不在 handler 内部，而在 ACI executor 的单例波次
 * （`run_graph` 声明 `isConcurrencySafe: false`，由
 * `concurrency-waves.ts` 把 unsafe 调用与其它调用分波 —— 已由
 * `tests/harness/aci/aci-executor-parallel.test.ts` AC47 覆盖）。
 * 裸 handler **没有** mutex：本测试按真实行为钉住它的后果 ——
 *
 *   1. call1 在跑（child 未 settle）时 call2 提交新节点 → call2 **不等待**
 *      call1，立即 spawn（它读到的账本是 segment-1 之前的空态，b 无冻结
 *      冲突、无失败 dep，merge 放行）；
 *   2. 每次调用只按自己的 settle 冻结自己的节点（a 由 call1 冻、b 由
 *      call2 冻），两段的 freeze 互不覆盖；
 *   3. 两段都 settle 后账本同时反映两段 —— 账本在任意调用顺序下保持
 *      一致（末次 freeze 以各自终态为准，无交叠 id 时不存在回写竞态）。
 *
 * 如果未来 handler 层加了显式串行化（per-conversation 队列），第 1 条
 * 断言会失败 —— 那时应改写本测试钉新契约，而不是放松断言。
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

/** 按 task 文本识别 child（两次调用的 spawn 顺序在事件循环里不保证）。 */
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

    // call1：提交 a，child spawn 后**先不 settle** —— 图在跑。
    const call1 = tool.handler(
      { nodes: [{ id: "a", task: "task-alpha" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    expect(children).toHaveLength(1);
    // call1 还没 settle → a 尚未冻结（freeze 只发生在自己 settle 之后）。
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(false);

    // call2：同一 conversationId，提交 b。裸 handler 不阻塞在 call1 上 ——
    // 它读到的账本是 segment-1 之前的空态（b 无冲突），照常 spawn。
    const call2 = tool.handler(
      { nodes: [{ id: "b", task: "task-beta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);

    // b 的 task 原样透传 —— call2 的 merge 看到的账本里没有可合并的
    // frozen-done 产出（segment-1 尚未 settle），没有东西被写进 b 的 task。
    const bChild = childByTask(children, "task-beta");
    expect(bChild.written.join("")).not.toContain("ALPHA-OUT");

    // settle call1 的 child → call1 收敛 → a 冻结（含产出）。
    settle(childByTask(children, "task-alpha"), ok("ALPHA-OUT"));
    const out1 = parseCondensed(await call1);
    expect(out1.nodes).toEqual([
      { id: "a", status: "done", output: "ALPHA-OUT" },
    ]);
    // b 仍未 settle → b 未冻结；a 已冻结 —— 各段冻结只跟自己的 settle 走。
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);
    expect(host.ledgerFor(CONV).isFrozen("b")).toBe(false);

    // settle call2 的 child → call2 收敛 → b 冻结。两段 freeze 汇合，
    // 账本同时反映两段、顺序按各段首次 freeze。
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
