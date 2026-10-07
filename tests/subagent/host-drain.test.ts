/**
 * host-drain unit tests (SC7 / OQ5).
 *
 * Coverage:
 *   - empty manager (undefined) → ""
 *   - manager with no completed → ""
 *   - 1 completed → single user message (## Sub-agent <id> result: <summary>\n\n[result])
 *   - several completed → joined with blank lines
 *   - mixed completed + running → running never appears (drainCompleted returns completed only)
 *
 * ADR-0014 — drain contract (async blocking poll + timeout guard):
 *   - empty manager / no tasks → "" immediately (no polling);
 *   - any completed → return the joined result immediately (do not wait for running);
 *   - running only → poll every pollMs until ≥1 task reaches a terminal state, or return "" once timeoutMs is spent;
 *   - drain never throws: internal waitFor rejections are caught as terminal → return partial or "".
 *   Callers await drainPendingSubagents(...) (now async; opts pass-through).
 *
 * fake SubAgentManager: drainCompleted() returns a fixed list; running items never enter the drain.
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

/** Build a fake SubAgentManager exposing drainCompleted (the sole host-drain dependency). */
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
    // the manager interface gained read-only enumeration methods — the fake implements them for structural compatibility.
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: () => () => {},
  };
}

/** Convenience factory for a fixed taskId + envelope. */
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
    // same length (both carry two tasks)
    assert.equal(first.split("## Sub-agent").length - 1, 2);
  });

  it("completed + running 混合 → running 不出现 (drainCompleted 已只返 completed)", async () => {
    // fakeManager pins drainCompleted to the completed subset only; running items are not exposed.
    const mgr = fakeManager([
      completedItem("tid-done-1", "done1", "r1"),
      completedItem("tid-done-2", "done2", "r2"),
    ]);
    // Even if the real manager still had running tasks (simulated data), the
    // drainCompleted API contract returns only completed → the drain output
    // carries no trace of running.
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
    // host drain semantics: pass condensed completed results to the model;
    // failure reasons are important info too. OQ5's buffer caches permanently,
    // so failed envelopes stay in the completed list and the parent sees them.
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
    // the prefix must include the trailing space to avoid false hits on user input like "## Sub-agentX".
    assert.equal(isSubagentDrainText("## Sub-agentX"), false);
  });

  it("trim 后以前缀开头即判定（容忍前导空白）", () => {
    assert.equal(isSubagentDrainText("  ## Sub-agent t result: s\n\nr"), true);
  });
});
