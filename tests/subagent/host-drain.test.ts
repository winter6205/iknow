/**
 * #356 T7 — host-drain 单测 (SC7 / OQ5)。
 *
 * 覆盖 (ticket 列点):
 *   - 空 manager (undefined) → ""
 *   - manager 无 completed → ""
 *   - 1 个 completed → 单一 user message (## Sub-agent <id> result: <summary>\n\n[result])
 *   - 多个 completed → 空行分隔的拼接串
 *   - 混合 completed + running → running 不出现 (drainCompleted 已只返 completed)
 *
 * fake SubAgentManager: 实现 drainCompleted() 返固定列表,running 列表项不入 drain。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

/** 构造 fake SubAgentManager,只暴露 drainCompleted (host drain 唯一依赖面)。 */
function fakeManager(
  completed: ReadonlyArray<{ taskId: string; envelope: SubAgentEnvelope }>
): SubAgentManager {
  return {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("not used by host-drain");
    },
    shutdown: async () => {},
    drainCompleted: () => completed,
  };
}

/** 构造 fixed taskId + envelope 的便利工厂。 */
function completedItem(taskId: string, summary: string, result: string) {
  return {
    taskId,
    envelope: { status: "ok", summary, result } as SubAgentEnvelope,
  };
}

describe("drainPendingSubagents (SC7 host-drain)", () => {
  it("undefined manager → 空串", () => {
    assert.equal(drainPendingSubagents(undefined), "");
  });

  it("manager 内无 completed → 空串", () => {
    const mgr = fakeManager([]);
    assert.equal(drainPendingSubagents(mgr), "");
  });

  it("1 个 completed → 单一 user message (## Sub-agent <id> result: <summary>\\n\\n[result])", () => {
    const mgr = fakeManager([
      completedItem("tid-aaa", "summ-A", "result-A-body"),
    ]);
    const out = drainPendingSubagents(mgr);
    assert.equal(out, "## Sub-agent tid-aaa result: summ-A\n\nresult-A-body");
  });

  it("多个 completed → 空行分隔的拼接串", () => {
    const mgr = fakeManager([
      completedItem("tid-a", "sA", "rA"),
      completedItem("tid-b", "sB", "rB"),
      completedItem("tid-c", "sC", "rC"),
    ]);
    const out = drainPendingSubagents(mgr);
    assert.equal(
      out,
      [
        "## Sub-agent tid-a result: sA\n\nrA",
        "## Sub-agent tid-b result: sB\n\nrB",
        "## Sub-agent tid-c result: sC\n\nrC",
      ].join("\n\n")
    );
  });

  it("不修改 manager 状态 — 同一 manager 多次 drain 返相同结果 (OQ5 buffer 永久缓存)", () => {
    const items = [
      completedItem("tid-x", "sX", "rX"),
      completedItem("tid-y", "sY", "rY"),
    ];
    const mgr = fakeManager(items);
    const first = drainPendingSubagents(mgr);
    const second = drainPendingSubagents(mgr);
    assert.equal(first, second);
    // 长度相同(都两个 task)
    assert.equal(first.split("## Sub-agent").length - 1, 2);
  });

  it("completed + running 混合 → running 不出现 (drainCompleted 已只返 completed)", () => {
    // fakeManager 把 drainCompleted 锁死成只返 completed 子集;running 项不暴露。
    const mgr = fakeManager([
      completedItem("tid-done-1", "done1", "r1"),
      completedItem("tid-done-2", "done2", "r2"),
    ]);
    // 即便真 manager 内还有 running 的 task (模拟数据),drainCompleted API 契约
    // 只返 completed → drain 输出不含 running 痕迹。
    const out = drainPendingSubagents(mgr);
    assert.ok(!out.includes("running"));
    assert.equal(
      out,
      [
        "## Sub-agent tid-done-1 result: done1\n\nr1",
        "## Sub-agent tid-done-2 result: done2\n\nr2",
      ].join("\n\n")
    );
  });

  it("envelope.failed 也进 drain (drainCompleted 不区分 ok/failed,completed 即可)", () => {
    // host drain 的语义 = 把 completed 的浓缩结果透给模型,失败原因也是重要信息。
    // OQ5 buffer 永久缓存,即使 failed 也在 completed 列表中,父代理可见失败。
    const mgr = fakeManager([
      {
        taskId: "tid-fail",
        envelope: {
          status: "failed",
          reason: "crashed",
          summary: "exit code=1",
          result: "",
        },
      },
    ]);
    const out = drainPendingSubagents(mgr);
    assert.equal(out, "## Sub-agent tid-fail result: exit code=1\n\n");
  });
});
