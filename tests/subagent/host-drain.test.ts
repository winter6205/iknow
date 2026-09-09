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
 * #361 / ADR-0014 V1.5 — C2 契约(drain 异步阻塞轮询 + 超时守卫):
 *   - 空 manager / 无任务 → 立即 ""(不轮询);
 *   - 任一 completed → 立即返回拼接结果(不等其它 running);
 *   - 仅 running → 每 pollMs 轮询至 ≥1 任务到终态返回,或 timeoutMs 耗尽返 "";
 *   - drain 永不抛:内部 waitFor 拒绝都被 catch 视为终态 → 返回部分或 ""。
 *   调用侧 await drainPendingSubagents(...) 升 async(opts 透传)。
 *
 * fake SubAgentManager: 实现 drainCompleted() 返固定列表,running 列表项不入 drain。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  drainPendingSubagents,
  isSubagentDrainText,
  SUBAGENT_DRAIN_PREFIX,
} from "../../src/harness/subagent/host-drain.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

/** 构造 fake SubAgentManager,只暴露 drainCompleted (host drain 唯一依赖面)。 */
function fakeManager(
  completed: ReadonlyArray<{ taskId: string; envelope: SubAgentEnvelope }>,
  listActiveImpl: () => ReadonlyArray<string> = () => [],
  waitForImpl: SubAgentManager["waitFor"] = async () => {
    throw new Error("not used by host-drain");
  },
  drainCompletedImpl: SubAgentManager["drainCompleted"] = () => completed
): SubAgentManager {
  return {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: waitForImpl,
    shutdown: async () => {},
    drainCompleted: drainCompletedImpl,
    listActive: listActiveImpl,
    abortTask: () => false,
    // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
    listSubagents: () => [],
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
  it("undefined manager → 空串", async () => {
    assert.equal(await drainPendingSubagents(undefined), "");
  });

  it("manager 内无 completed → 空串", async () => {
    const mgr = fakeManager([]);
    assert.equal(await drainPendingSubagents(mgr), "");
  });

  it("仍有 running worker → 立刻空返且不调用 waitFor (无轮询)", async () => {
    let waitCalls = 0;
    const mgr = fakeManager(
      [],
      () => ["tid-running"],
      async () => {
        waitCalls++;
        throw new Error("waitFor must not be called by host-drain");
      }
    );

    assert.equal(
      await drainPendingSubagents(mgr, { pollMs: 1, timeoutMs: 10_000 }),
      ""
    );
    assert.equal(waitCalls, 0);
  });

  it("SC4: success drain 文本含 task_id 与 tmp_root，无产物名单", async () => {
    const mgr = fakeManager([
      {
        taskId: "tid-drain",
        envelope: {
          status: "ok",
          summary: "summ",
          result: "summ",
          task_id: "tid-drain",
          tmp_root: "/pad/tid-drain/fence-tmp",
        },
      },
    ]);
    const out = await drainPendingSubagents(mgr);
    assert.match(out, /tid-drain/);
    assert.match(out, /\/pad\/tid-drain\/fence-tmp/);
    assert.doesNotMatch(out, /product_roster/);
  });

  it("SC4: failure drain 文本同样含 task_id 与 tmp_root", async () => {
    const mgr = fakeManager([
      {
        taskId: "tid-fail",
        envelope: {
          status: "failed",
          reason: "crashed",
          summary: "boom",
          result: "",
          task_id: "tid-fail",
          tmp_root: "/pad/tid-fail/fence-tmp",
        },
      },
    ]);
    const out = await drainPendingSubagents(mgr);
    assert.match(out, /tid-fail/);
    assert.match(out, /\/pad\/tid-fail\/fence-tmp/);
  });

  it("1 个 completed → 单一 user message (## Sub-agent <id> result: <summary>\\n\\n[result])", async () => {
    const mgr = fakeManager([
      completedItem("tid-aaa", "summ-A", "result-A-body"),
    ]);
    const out = await drainPendingSubagents(mgr);
    assert.equal(out, "## Sub-agent tid-aaa result: summ-A\n\nsumm-A");
  });

  it("多个 completed → 空行分隔的拼接串", async () => {
    const mgr = fakeManager([
      completedItem("tid-a", "sA", "rA"),
      completedItem("tid-b", "sB", "rB"),
      completedItem("tid-c", "sC", "rC"),
    ]);
    const out = await drainPendingSubagents(mgr);
    assert.equal(
      out,
      [
        "## Sub-agent tid-a result: sA\n\nsA",
        "## Sub-agent tid-b result: sB\n\nsB",
        "## Sub-agent tid-c result: sC\n\nsC",
      ].join("\n\n")
    );
  });

  it("不修改 manager 状态 — 同一 manager 多次 drain 返相同结果 (OQ5 buffer 永久缓存)", async () => {
    const items = [
      completedItem("tid-x", "sX", "rX"),
      completedItem("tid-y", "sY", "rY"),
    ];
    const mgr = fakeManager(items);
    const first = await drainPendingSubagents(mgr);
    const second = await drainPendingSubagents(mgr);
    assert.equal(first, second);
    // 长度相同(都两个 task)
    assert.equal(first.split("## Sub-agent").length - 1, 2);
  });

  it("completed + running 混合 → running 不出现 (drainCompleted 已只返 completed)", async () => {
    // fakeManager 把 drainCompleted 锁死成只返 completed 子集;running 项不暴露。
    const mgr = fakeManager([
      completedItem("tid-done-1", "done1", "r1"),
      completedItem("tid-done-2", "done2", "r2"),
    ]);
    // 即便真 manager 内还有 running 的 task (模拟数据),drainCompleted API 契约
    // 只返 completed → drain 输出不含 running 痕迹。
    const out = await drainPendingSubagents(mgr);
    assert.ok(!out.includes("running"));
    assert.equal(
      out,
      [
        "## Sub-agent tid-done-1 result: done1\n\ndone1",
        "## Sub-agent tid-done-2 result: done2\n\ndone2",
      ].join("\n\n")
    );
  });

  it("envelope.failed 也进 drain (drainCompleted 不区分 ok/failed,completed 即可)", async () => {
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
    const out = await drainPendingSubagents(mgr);
    assert.equal(
      out,
      "## Sub-agent tid-fail result: exit code=1\n\nexit code=1"
    );
  });

  it("manager drain 出错 → 空串且不抛", async () => {
    const mgr = fakeManager(
      [],
      () => [],
      async () => {
        throw new Error("waitFor must not be called by host-drain");
      },
      () => {
        throw new Error("buffer unavailable");
      }
    );

    await assert.doesNotReject(async () => {
      assert.equal(await drainPendingSubagents(mgr), "");
    });
  });
});

describe("isSubagentDrainText / SUBAGENT_DRAIN_PREFIX (SSOT 同源)", () => {
  it("单 task drain 输出满足谓词且以前缀开头", async () => {
    const mgr = fakeManager([completedItem("tid-a", "sA", "rA")]);
    const out = await drainPendingSubagents(mgr);
    assert.equal(isSubagentDrainText(out), true);
    assert.ok(out.startsWith(SUBAGENT_DRAIN_PREFIX));
  });

  it("多 task 拼接输出仍满足谓词（首项前缀在头）", async () => {
    const mgr = fakeManager([
      completedItem("tid-a", "sA", "rA"),
      completedItem("tid-b", "sB", "rB"),
    ]);
    assert.equal(isSubagentDrainText(await drainPendingSubagents(mgr)), true);
  });

  it("普通用户文本不满足谓词", () => {
    assert.equal(isSubagentDrainText("hello world"), false);
    assert.equal(isSubagentDrainText(""), false);
    // 前缀必须含尾随空格，避免误伤 "## Sub-agentX" 之类用户输入。
    assert.equal(isSubagentDrainText("## Sub-agentX"), false);
  });

  it("trim 后以前缀开头即判定（容忍前导空白）", () => {
    assert.equal(isSubagentDrainText("  ## Sub-agent t result: s\n\nr"), true);
  });
});
