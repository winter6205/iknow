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
 *   Callers await peekPendingSubagents(...) (now async; opts pass-through).
 *
 * fake SubAgentManager: drainCompleted() returns a fixed list; running items never enter the drain.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  peekPendingSubagents,
  claimPendingSubagents,
  isSubagentDrainText,
  SUBAGENT_DRAIN_PREFIX,
} from "../../src/harness/subagent/host-drain.ts";
import {
  createDeliveryLedger,
  type ClaimedDelivery,
} from "../../src/harness/subagent/delivery-ledger.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubagentManagerDrainView } from "../../src/harness/subagent/manager-registry.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

/**
 * The fake exposes only what host-drain actually reads: `drainCompleted`
 * (plus `waitFor` / `listActive`, so the "no polling" assertion has something
 * to observe). It deliberately has NO claim seam — that is the "view without
 * the claim seam falls back to the read-only path" case.
 */
type FakeDrainManager = SubagentManagerDrainView &
  Pick<SubAgentManager, "waitFor" | "listActive">;

/** Build a fake drain view exposing drainCompleted (the sole host-drain dependency). */
function fakeManager(
  completed: ReadonlyArray<{ taskId: string; envelope: SubAgentEnvelope }>,
  listActiveImpl: () => ReadonlyArray<string> = () => [],
  waitForImpl: SubAgentManager["waitFor"] = async () => {
    throw new Error("not used by host-drain");
  },
  drainCompletedImpl: SubAgentManager["drainCompleted"] = () => completed
): FakeDrainManager {
  return {
    waitFor: waitForImpl,
    drainCompleted: drainCompletedImpl,
    listActive: listActiveImpl,
  };
}

/** Convenience factory for a fixed taskId + envelope. */
function completedItem(taskId: string, summary: string, result: string) {
  return {
    taskId,
    envelope: { status: "ok", summary, result } as SubAgentEnvelope,
  };
}

/**
 * A drain view backed by the REAL delivery ledger, so the claim / ack /
 * release semantics under test are the production ones (ADR-0150). Every
 * entry gets its own terminal generation, so two entries are two keys.
 */
function ledgerView(
  completed: ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>
): SubagentManagerDrainView {
  const ledger = createDeliveryLedger();
  const rows = completed.map((entry, index) => ({
    conversationId: "",
    taskId: entry.taskId,
    terminalSeq: index + 1,
    envelope: entry.envelope,
  }));
  return {
    drainCompleted: (_conversationId, opts) => {
      const scoped = rows;
      const visible =
        opts?.includeDelivered === true ? scoped : ledger.undelivered(scoped);
      return visible.map((row) => ({
        taskId: row.taskId,
        envelope: row.envelope,
      }));
    },
    claimCompleted: () => ledger.claim(rows),
    acknowledgeDeliveries: (claims) => ledger.acknowledge(claims),
    releaseDeliveries: (claims) => ledger.release(claims),
  };
}

describe("peekPendingSubagents (SC7 host-drain)", () => {
  it("undefined manager → 空串", async () => {
    assert.equal(await peekPendingSubagents(undefined), "");
  });

  it("manager 内无 completed → 空串", async () => {
    const mgr = fakeManager([]);
    assert.equal(await peekPendingSubagents(mgr), "");
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
      await peekPendingSubagents(mgr, { pollMs: 1, timeoutMs: 10_000 }),
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
    const out = await peekPendingSubagents(mgr);
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
    const out = await peekPendingSubagents(mgr);
    assert.match(out, /tid-fail/);
    assert.match(out, /\/pad\/tid-fail\/fence-tmp/);
  });

  it("1 个 completed → 单一 user message (## Sub-agent <id> result: <summary>\\n\\n[result])", async () => {
    const mgr = fakeManager([
      completedItem("tid-aaa", "summ-A", "result-A-body"),
    ]);
    const out = await peekPendingSubagents(mgr);
    assert.equal(out, "## Sub-agent tid-aaa result: summ-A\n\nsumm-A");
  });

  it("多个 completed → 空行分隔的拼接串", async () => {
    const mgr = fakeManager([
      completedItem("tid-a", "sA", "rA"),
      completedItem("tid-b", "sB", "rB"),
      completedItem("tid-c", "sC", "rC"),
    ]);
    const out = await peekPendingSubagents(mgr);
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
    const first = await peekPendingSubagents(mgr);
    const second = await peekPendingSubagents(mgr);
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
    const out = await peekPendingSubagents(mgr);
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
    const out = await peekPendingSubagents(mgr);
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
      assert.equal(await peekPendingSubagents(mgr), "");
    });
  });
});

describe("claimPendingSubagents (ADR-0150 delivery take)", () => {
  it("claims once: a second claim returns no text", async () => {
    const view = ledgerView([completedItem("tid-claim", "sC", "sC")]);

    const first = await claimPendingSubagents(view);
    assert.equal(first.text, "## Sub-agent tid-claim result: sC\n\nsC");
    assert.notEqual(first.claims, null, "a taken claim is settleable");

    const second = await claimPendingSubagents(view);
    assert.equal(second.text, "", "the generation is already claimed");
  });

  it("claims never consume: peek is stable before any claim", async () => {
    const view = ledgerView([completedItem("tid-peek", "sP", "sP")]);

    const first = await peekPendingSubagents(view);
    const second = await peekPendingSubagents(view);
    assert.equal(first, "## Sub-agent tid-peek result: sP\n\nsP");
    assert.equal(second, first);
  });

  it("acknowledge makes the result invisible to the next claim and peek", async () => {
    const view = ledgerView([completedItem("tid-ack", "sA", "sA")]);
    const claimed = await claimPendingSubagents(view);
    assert.notEqual(claimed.claims, null);

    claimed.claims?.acknowledge();

    assert.equal((await claimPendingSubagents(view)).text, "");
    assert.equal(await peekPendingSubagents(view), "");
  });

  it("release makes the result claimable again, with the same text", async () => {
    const view = ledgerView([completedItem("tid-rel", "sR", "sR")]);
    const claimed = await claimPendingSubagents(view);
    assert.notEqual(claimed.claims, null);

    claimed.claims?.release();

    assert.equal(await peekPendingSubagents(view), claimed.text);
    const reclaimed = await claimPendingSubagents(view);
    assert.equal(reclaimed.text, claimed.text);
  });

  it("acknowledge after release is a no-op and does not re-deliver", async () => {
    const view = ledgerView([completedItem("tid-stale", "sS", "sS")]);
    const claimed = await claimPendingSubagents(view);
    claimed.claims?.release();
    claimed.claims?.acknowledge();

    // The stale token never settles the new state: the entry is still
    // claimable (ack of a released claim is ignored by the ledger).
    assert.equal(
      (await claimPendingSubagents(view)).text,
      "## Sub-agent tid-stale result: sS\n\nsS"
    );
  });

  it("digestText equals the text this round claimed", async () => {
    const view = ledgerView([
      completedItem("tid-d1", "s1", "s1"),
      completedItem("tid-d2", "s2", "s2"),
    ]);

    const drain = await claimPendingSubagents(view);
    assert.equal(drain.digestText, drain.text);
    assert.equal(
      drain.digestText,
      [
        "## Sub-agent tid-d1 result: s1\n\ns1",
        "## Sub-agent tid-d2 result: s2\n\ns2",
      ].join("\n\n")
    );
  });

  it("a view without the claim seam falls back to the read-only path", async () => {
    const mgr = fakeManager([completedItem("tid-ro", "sO", "sO")]);

    const drain = await claimPendingSubagents(mgr);
    assert.equal(drain.text, "## Sub-agent tid-ro result: sO\n\nsO");
    assert.equal(drain.digestText, drain.text);

    // The no-op claim neither throws nor hides the read.
    drain.claims?.acknowledge();
    drain.claims?.release();
    assert.equal(await peekPendingSubagents(mgr), drain.text);
  });

  it("a throwing read yields empty text and null claims, never throws", async () => {
    const mgr = fakeManager(
      [],
      () => [],
      async () => {
        throw new Error("not used by host-drain");
      },
      () => {
        throw new Error("buffer unavailable");
      }
    );

    await assert.doesNotReject(async () => {
      const drain = await claimPendingSubagents(mgr);
      assert.deepEqual(drain, {
        text: "",
        digestText: "",
        claims: null,
      });
    });
  });

  it("a throwing claim seam yields empty text and null claims, never throws", async () => {
    const view: SubagentManagerDrainView = {
      drainCompleted: () => [],
      claimCompleted: () => {
        throw new Error("ledger unavailable");
      },
      acknowledgeDeliveries: () => {},
      releaseDeliveries: () => {},
    };

    await assert.doesNotReject(async () => {
      const drain = await claimPendingSubagents(view);
      assert.deepEqual(drain, {
        text: "",
        digestText: "",
        claims: null,
      });
    });
  });

  it("a claim taken before a condensation failure goes back", async () => {
    // The claim succeeded; formatting its envelope throws. Without the
    // release in the failure path the generation stays claimed forever and
    // is never offered again (ADR-0150).
    const poisoned = {
      status: "ok",
      summary: "s",
      result: "r",
    } as SubAgentEnvelope;
    Object.defineProperty(poisoned, "result", {
      enumerable: true,
      get() {
        throw new Error("condensation unavailable");
      },
    });
    let released: ReadonlyArray<ClaimedDelivery<unknown>> | undefined;
    const view: SubagentManagerDrainView = {
      drainCompleted: () => [],
      claimCompleted: () => [
        {
          key: "k",
          token: Symbol("k"),
          conversationId: "",
          taskId: "tid-boom",
          terminalSeq: 1,
          envelope: poisoned,
        },
      ],
      acknowledgeDeliveries: () => {
        throw new Error("a failed round must not acknowledge");
      },
      releaseDeliveries: (claims) => {
        released = claims;
      },
    };

    const drain = await claimPendingSubagents(view);
    assert.deepEqual(drain, { text: "", digestText: "", claims: null });
    assert.equal(released?.length, 1, "the taken claim was released");
  });

  it("a throwing release seam still yields the non-throwing empty drain", async () => {
    // The hub calls this outside any try. A release seam that throws must not
    // turn "deliver nothing this round" into an escaped error.
    const poisoned = {
      status: "ok",
      summary: "s",
      result: "r",
    } as SubAgentEnvelope;
    Object.defineProperty(poisoned, "summary", {
      enumerable: true,
      get() {
        throw new Error("condensation unavailable");
      },
    });
    const view: SubagentManagerDrainView = {
      drainCompleted: () => [],
      claimCompleted: () => [
        {
          key: "k",
          token: Symbol("k"),
          conversationId: "",
          taskId: "tid-boom",
          terminalSeq: 1,
          envelope: poisoned,
        },
      ],
      acknowledgeDeliveries: () => {},
      releaseDeliveries: () => {
        throw new Error("release exploded");
      },
    };

    await assert.doesNotReject(async () => {
      assert.deepEqual(await claimPendingSubagents(view), {
        text: "",
        digestText: "",
        claims: null,
      });
    });
  });

  it("undefined manager yields empty text and null claims", async () => {
    assert.deepEqual(await claimPendingSubagents(undefined), {
      text: "",
      digestText: "",
      claims: null,
    });
  });
});

describe("isSubagentDrainText / SUBAGENT_DRAIN_PREFIX (SSOT 同源)", () => {
  it("单 task drain 输出满足谓词且以前缀开头", async () => {
    const mgr = fakeManager([completedItem("tid-a", "sA", "rA")]);
    const out = await peekPendingSubagents(mgr);
    assert.equal(isSubagentDrainText(out), true);
    assert.ok(out.startsWith(SUBAGENT_DRAIN_PREFIX));
  });

  it("多 task 拼接输出仍满足谓词（首项前缀在头）", async () => {
    const mgr = fakeManager([
      completedItem("tid-a", "sA", "rA"),
      completedItem("tid-b", "sB", "rB"),
    ]);
    assert.equal(isSubagentDrainText(await peekPendingSubagents(mgr)), true);
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
