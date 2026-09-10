/**
 * live-graph-phase1 T3 — 取消保留已 done（spec SC8）。
 *
 * 走真 `SubAgentManager`（fake spawn + 假 child，与 run-graph-residual.test.ts
 * 同模式）。覆盖：
 *
 *   - SC8：a→b 链在 a done 后 abort → a 冻结（含产出，`outputOf` 可读）、
 *     b 不冻结（abort 的 failed 只是取消症状，整段可再交）；handler typed
 *     取消拒绝，不把半图当成功 condense；随后只交 b（deps: [a]）→ b 真
 *     spawn、读到 a 的账本产出、成功。
 *   - SC8 边界：signal 在 spawn 前已 aborted → 零冻结、零 spawn、typed 取消。
 *   - SC6 回归钉：非取消的正常 settle 里 failed 仍冻结（T3 只改 abort 路径，
 *     正常失败冻结语义不变）。
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

// ── SC8：a done 后 abort → a 冻结、b 不冻、b 可再交 ───────────────────

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
    // 确定性锚：scheduler 的 onNode(a, done) 触发的 graph_progress 事件是
    // 「a 已被 runGraph 记为 done」的 ground truth —— abort 必须等它，否则
    // waitFor 的 25ms 轮询间隙里 abort 会把 a 也打成 failed（取消症状），
    // 测的就不是「a 真 done 后取消」了。
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
    // a 已被 scheduler 记为 done、b 的 wave 还没开 —— 此刻取消。b 的结果
    // 无论走 spawn 前预检查（failed）还是 waitFor abort，都不能冻成 done。
    controller.abort();

    // handler typed 取消拒绝 —— 半图不当成功 condense（ADR-0065 / SC8）。
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);

    // SC8：已 done 的 a 冻结且产出可读；b 未冻结。
    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe("A-OUTPUT");
    expect(ledger.isFrozen("b")).toBe(false);

    // 剩余子图：只交 b（deps: [a]，a 已 done 从账本满足）→ b 真 spawn、
    // task 文本接到 a 的产出 —— 证明 b 可再交且 a 的产出沿边流动。
    const childrenBefore = children.length;
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb", deps: ["a"] }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, childrenBefore + 1);
    // b 是本段唯一新 spawn：a 不重演（账本冻结），b 不因 abort 被误冻。
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
    controller.abort(); // 进 handler 前就已取消

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
    // 账本已建（校验通过后 ensure），但没有 id 被冻结 —— 全部可再交。
    expect(host.ledgerFor(CONV).exists()).toBe(true);
    expect(host.ledgerFor(CONV).frozenIds()).toEqual([]);
    await manager.shutdown();
  });
});

// ── phase2 C5：失败边图上的调用侧取消 ─────────────────────────────────

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
    // onNode 回调不可直接拿（handler 内部接 progress）—— 用 graph_progress
    // 事件流作「a 第二次进入已 settle ok」的锚（与上方 SC8 测试同模式）。
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
    // 首进 failed → self 失败边 kick a(2)
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // a(2) settle ok —— graph_progress 事件里 a 出现 done（onNode 末次
    // 触发即此）。abort 打在 a(2) 已落定之后。
    await waitForChildren(children, 2);
    settle(children[1]!, ok("A-RETRY"));
    await doneA;
    controller.abort();

    // handler typed 取消拒绝（abort 后 no-new-entries 使调度收敛）。
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);
    // cancel 规则「仅冻 done」：a 的末次结局 done（末次覆盖前次）→
    // 冻结 done、产出可读 —— 取消不吞真结局。
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
    // 首进 ok（真 done，冻结候选）
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    // self 失败边 kick a(2)（再进入波）；在 a(2) 落定**之前** abort。
    await waitForChildren(children, 2);
    controller.abort();
    // a(2) 仍按其真实结局落定 —— settle failed（取消症状 failed）。
    settle(children[1]!, fail("still-crashed"));

    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/cancel/i);
    // cancel 规则：abort 症状 failed 不冻结 —— a 未冻，下一段可再交。
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
