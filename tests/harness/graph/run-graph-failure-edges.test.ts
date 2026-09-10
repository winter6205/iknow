/**
 * live-graph-phase2 T2 — handler 级失败边驱动（spec SC1–SC3 / SC6 / SC8
 * / ADR-0053–0056、0062–0063）。
 *
 * 与 outcome-scheduler.test.ts 的分工：本组测试走真 `SubAgentManager` +
 * 假 child（与 run-graph-executor.test.ts 同模式），验证：
 *   - **SC1 / SC2 / SC3**：handler 真的把 `onFailure` 当事件源驱动
 *     executor，envelope 的 failed/done 决定失败边是否启动；skipped
 *     节点不触发失败边。
 *   - **SC6**：同一个 id 因失败边被两次 executor 进入 —— `children` 数
 *     比 spec.nodes 数大（这一刀是上一组 stub 测试在 wire 级重复印证）。
 *   - **SC8**：handler 调用是阻塞的；失败回走完成后 `await tool.handler`
 *     才返回——没有 wait:false。
 *   - **mid-run violation**：终点本段已 done 时，handler typed 拒、保留
 *     部分 done 结果进账本（ADR-0060 / 阶段 1 freeze 语义）。
 *   - **回归 pin**：无失败边的图仍走 plain `runGraph` Kahn。
 *
 * 这些测试不试图重写 outcome-scheduler 的算法——直接用真 manager 走
 * `runGraphWithFailureEdges` 在 handler 里的两条路径。
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
    // 首进 failed
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // 自回边触发同 id 第二次进入
    await waitForChildren(children, 2);
    expect(children).toHaveLength(2);
    settle(children[1]!, ok("A-RETRY"));
    // SC8:整段阻塞 —— await handler 之后才拿到结果
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
    // d 在 c failed 后被失败边启动（依赖 deps 路径已被 c 走失败而替换）
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
    // wave 0: b 实跑
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // c 沿 deps fail-fast 被 skipped（不进 executor），不触发失败边
    // d 跟着 skipped
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
    // wave 0: a、b 同波并发
    await waitForChildren(children, 2);
    settle(children[0]!, fail("crashed"));
    settle(children[1]!, fail("crashed"));
    // a 的失败边未启动（a 没有 onFailure）
    // b 的失败边 → a 再跑（a 此刻仍未冻）
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

    // wave 0: b 实跑且 done（它的失败边终点尚未定义）
    // a 的失败边指向 b，b 在本段先 done → a failed 时不应 kick b
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
    // typed 拒绝 —— partial results preserved
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/already done/);
    // b 已冻结（done 在 settle 后写进账本，violation typed 拒前 freeze）
    const frozen = host.ledgerFor(CONV).frozenIds();
    expect(frozen).toContain("b");
    expect(host.ledgerFor(CONV).statusOf("b")).toBe("done");
    // 没有第三次 spawn（不会因失败边再跑 done）
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });

  it("violation 波内已落定 done 的同波兄弟也冻结（整波先记录再判违规，ADR-0050）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // wave 0 同波三个根节点，settle 顺序 b(done) → a(failed) → c(done)：
    // a 的失败边指向本段先 done 的 b → violation。c 与失败边无关，但与
    // a 同波且已真跑完 —— 整波结局必须先全部记录，violation 才允许抬
    // （否则 c 不进 results、freeze 冻不到它，下一段外环重交 c 会被
    // 再跑一次，违反 ADR-0050「已完成不重演」）。
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
    // 同波 done 兄弟 c 与触发点 b 一起冻结进账本。**真正的失败起点 a 也
    // 必须冻结为 failed** —— F1 review fix 的承诺：violation 抬升前已
    // 把整波 settle 结果写进 results，freezeResults 沿用正常 settle 路径
    // 冻 done + 真 failed（不是 cancel 路径的「仅冻 done」），所以 a 与
    // 兄弟 b/c 一起冻。否则下一段剩余子图重交 a 会被允许再 spawn，违
    // 反 ADR-0050「已完成不重演」（冻结语义见 run-graph-tool.ts
    // freezeResults 的 F2 注释）。
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("a")).toBe("failed");
    expect(ledger.statusOf("b")).toBe("done");
    expect(ledger.statusOf("c")).toBe("done");
    expect(ledger.frozenIds()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    // 无多余 spawn（c 不重跑）
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
    // a(self-onFailure) + b：a 失败走失败边再进，b 普通节点。a(1) 先
    // settle failed，b 的 child spawn 后不 settle —— 在这个间隙销毁
    // 账本（模拟 reset / 会话结束与 run_graph 并发的窗口）。
    const pending = t.handler(
      {
        nodes: [{ id: "a", task: "ta", onFailure: "a" }],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.exists()).toBe(true);
    // a(1) settle failed → self 失败边 kick a(2)。
    settle(children[0]!, fail("crashed"));
    await waitForChildren(children, 2);
    // 销毁账本 —— handler 闭包里持有的 ledger 引用仍在，但冻结集合
    // 与 created 标志已清空。
    host.destroy(CONV);
    // a(2) settle ok：handler 收敛后调 freezeResults —— 对已销毁
    // 账本（created === false）这是静默 no-op，不得 crash。
    settle(children[1]!, ok("A-RETRY"));
    const out = parse(await pending);
    expect(out.nodes).toEqual([{ id: "a", status: "done", output: "A-RETRY" }]);
    // 账本保持销毁态：freeze no-op 没有重建任何冻结痕迹（ACI 序列化
    // 是真正的并发守卫；本测试钉的是「destroy 后 freeze 不复活账本」
    // 这一防御性边界，而不是并发语义本身）。
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
    // 确定性锚：graph_progress 事件里 a 出现 done 才 abort —— 否则
    // waitFor 的 25ms 轮询间隙里 abort 会把 a 打成取消症状 failed
    // （run-graph-cancel.test.ts SC8 同款锚）。
    const events: Array<{
      type: string;
      snapshot?: { nodes: Array<{ id: string; status: string }> };
    }> = [];
    let wakeDoneA: () => void = () => {};
    const doneA = new Promise<void>((resolve) => {
      wakeDoneA = resolve;
    });

    // 第一段：a 跑完 done 后 abort（与 run-graph-cancel.test.ts SC8 同
    // 模式 —— a 冻结 done）。
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

    // 第二段：提交 r(onFailure:a) —— a 在账本上是已冻结 done（ADR-0060：
    // done 永不因失败边再跑）。mergeResidual 的 frozen 重交拒绝 + 失败边
    // frozen-target 拒绝都会触发。typed 拒、零 spawn、账本冻结集合不变。
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
