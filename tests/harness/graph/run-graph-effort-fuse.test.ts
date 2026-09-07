/**
 * live-graph-phase2 T3 — effort 熔断（spec SC7 / ADR-0057 / 0064）。
 *
 * 与 outcome-scheduler.test.ts / run-graph-failure-edges.test.ts 的分工：
 * 熔断闸在 handler 的 executor 入口（run-graph-tool.ts 的 exec 闭包现装
 * createEffortFuse），不在调度器 / 校验层里。本组测试走真 SubAgentManager
 * + 假 child，验证：
 *   - **SC7 熔断**：同一 id 第 9 次 executor 进入 → 整次调用 typed 拒、
 *     第 9 进入零 spawn（调度收敛、不空转）。
 *   - **SC7 合法绕回**：进入 ≤8 不熔断（7 次失败 + 第 8 次 done）。
 *   - **SC7 冻结保留**：熔断后已 done 的 id 仍冻结（与 T2 violation 同一
 *     partial-results 通道：先 freeze 再拒）。
 *   - **熔断按单次调用计**：熔断后外环下一段交新 id 正常 spawn。
 *   - **SC9 不回退**：plain Kahn 路径（无 onFailure）不装计数器。
 *   - **ADR-0064**：阈值常量 = 8，不进 settings（createRunGraphTool deps
 *     无阈值旋钮 —— typecheck 级守门，这里钉常量值本身）。
 */

import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { createEffortFuse } from "../../../src/harness/graph/effort-fuse.ts";
import { EFFORT_FUSE_THRESHOLD } from "../../../src/harness/graph/effort-threshold.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import {
  makeManager,
  settle,
  ok,
  fail,
  waitForChildren,
  parseCondensed as parse,
} from "./_fake-manager.ts";

const CONV = "conv-p2-t3";

describe("createEffortFuse — 计数器单元", () => {
  it("每 id 独立计数：第 9 次进入同一 id 才熔断", () => {
    const fuse = createEffortFuse();
    for (let i = 0; i < EFFORT_FUSE_THRESHOLD; i++) {
      expect(fuse.enter("a")).toBe(true);
    }
    expect(fuse.signal.aborted).toBe(false);
    expect(fuse.enter("a")).toBe(false); // 第 9 次
    expect(fuse.signal.aborted).toBe(true);
    expect(fuse.trippedBy).toBe("a");
  });

  it("不同 id 互不挤占；熔断后一切进入都拒且不再计数", () => {
    const fuse = createEffortFuse();
    for (let i = 0; i < EFFORT_FUSE_THRESHOLD; i++) {
      expect(fuse.enter("a")).toBe(true);
      expect(fuse.enter("b")).toBe(true);
    }
    expect(fuse.enter("a")).toBe(false);
    expect(fuse.trippedBy).toBe("a");
    expect(fuse.enter("b")).toBe(false);
    expect(fuse.enter("c")).toBe(false);
    expect(fuse.trippedBy).toBe("a");
  });

  it("ADR-0064：阈值常量 = 8（不进 settings —— deps 类型无旋钮，typecheck 守门）", () => {
    expect(EFFORT_FUSE_THRESHOLD).toBe(8);
  });
});

describe("run_graph effort fuse — SC7 第 9 次进入熔断", () => {
  it("self-onFailure 恒 failed：第 9 进入不 spawn、整次调用 typed 拒、done 仍冻结", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    // b 依赖 a：先让 a done（冻结候选），再让 b 恒 failed 空转
    const pending = t.handler(
      {
        nodes: [
          { id: "a", task: "ta" },
          { id: "b", task: "tb", deps: ["a"], onFailure: "b" },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OK"));
    // b 进入 1..8 各 spawn 一次（children[1..8]）；b 依赖的 a 已 done，
    // 同 id 再进入合法（失败边绕过 deps 门）。
    for (let entry = 1; entry <= 8; entry++) {
      await waitForChildren(children, entry + 1);
      settle(children[entry]!, fail("crashed"));
    }
    // 第 9 次进入被熔断：不再 spawn，整次调用 typed 拒
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/effort fuse/);
    expect(children).toHaveLength(9); // a 1 次 + b 8 次，第 9 进入零 spawn
    // partial-results（T2 violation 同通道）：done 先冻结再拒
    const ledger = host.ledgerFor(CONV);
    expect(ledger.frozenIds()).toContain("a");
    expect(ledger.statusOf("a")).toBe("done");
    await manager.shutdown();
  });
});

describe("run_graph effort fuse — SC7 进入 ≤8 合法绕回不熔断", () => {
  it("7 次失败 + 第 8 次进入 done：正常返回、不熔断", async () => {
    const { manager, children } = makeManager();
    const t = createRunGraphTool({ manager, isEnabled: () => true });
    const pending = t.handler(
      { nodes: [{ id: "b", task: "tb", onFailure: "b" }] },
      { conversationId: CONV }
    );
    for (let entry = 1; entry <= 7; entry++) {
      await waitForChildren(children, entry);
      settle(children[entry - 1]!, fail("crashed"));
    }
    await waitForChildren(children, 8);
    settle(children[7]!, ok("B-RECOVERED")); // 第 8 次进入（含首次）合法
    const out = parse(await pending);
    expect(children).toHaveLength(8);
    expect(out.nodes).toEqual([
      { id: "b", status: "done", output: "B-RECOVERED" },
    ]);
    await manager.shutdown();
  });
});

describe("run_graph effort fuse — 熔断按单次调用计", () => {
  it("熔断后外环下一段交新 id：正常 spawn、正常返回", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    // 第一段：a self-onFailure 恒 failed → 第 9 进入熔断
    const first = t.handler(
      { nodes: [{ id: "a", task: "ta", onFailure: "a" }] },
      { conversationId: CONV }
    );
    for (let entry = 1; entry <= 8; entry++) {
      await waitForChildren(children, entry);
      settle(children[entry - 1]!, fail("crashed"));
    }
    await expect(first).rejects.toThrow(/effort fuse/);
    expect(children).toHaveLength(8);
    // 第二段（同一会话账本）：新 id 不受上一段熔断影响
    const second = t.handler(
      { nodes: [{ id: "n", task: "tn" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 9);
    settle(children[8]!, ok("N-OK"));
    const out = parse(await second);
    expect(out.nodes).toEqual([{ id: "n", status: "done", output: "N-OK" }]);
    await manager.shutdown();
  });
});

describe("run_graph effort fuse — SC9 plain Kahn 不装计数器", () => {
  it("无 onFailure 的 DAG 不受熔断影响：正常 Kahn 两波", async () => {
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
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });
});
