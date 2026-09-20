/**
 * Effort fuse (ADR-0057 / ADR-0064).
 *
 * Division of labor with outcome-scheduler.test.ts / run-graph-failure-edges.test.ts:
 * the fuse gate lives at the handler's executor entry (run-graph-tool.ts's
 * exec closure installs a fresh createEffortFuse), not in the scheduler or
 * validation layer. These tests use a real SubAgentManager + fake child and verify:
 *   - **Fuse trip**: the 9th executor entry for one id → the whole call is
 *     rejected with a typed error, the 9th entry spawns nothing (scheduling
 *     converges, no spinning).
 *   - **Legal escape**: entries ≤ 8 never trip (7 failures + 8th entry done).
 *   - **Freeze retention**: after a trip, ids already done stay frozen (same
 *     partial-results channel as the violation path: freeze first, then reject).
 *   - **Per-call counting**: the next outer-loop segment with new ids spawns normally.
 *   - **No regression**: the plain Kahn path (no onFailure) installs no counter.
 *   - **ADR-0064**: threshold constant = 8, deliberately not in settings
 *     (createRunGraphTool deps expose no threshold knob — a typecheck-level
 *     guard; this file pins the constant itself).
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
    expect(fuse.enter("a")).toBe(false); // the 9th entry
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
    // b depends on a: let a go done first (freeze candidate), then spin b always-failed.
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
    // b entries 1..8 each spawn once (children[1..8]); its dep a is already
    // done, and re-entry under the same id is legal (the failure edge bypasses the deps gate).
    for (let entry = 1; entry <= 8; entry++) {
      await waitForChildren(children, entry + 1);
      settle(children[entry]!, fail("crashed"));
    }
    // The 9th entry trips the fuse: no more spawns, whole call typed-rejected.
    await expect(pending).rejects.toThrow(ToolExecutionError);
    await expect(pending).rejects.toThrow(/effort fuse/);
    expect(children).toHaveLength(9); // a once + b eight times; the 9th entry spawns nothing
    // Partial results (same channel as the violation path): done freezes before the rejection.
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
    settle(children[7]!, ok("B-RECOVERED")); // 8th entry overall (incl. first) is still legal
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
    // Segment 1: a with self-onFailure always fails → the 9th entry trips the fuse.
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
    // Segment 2 (same-session ledger): a new id is unaffected by the previous trip.
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

describe("run_graph effort fuse — SC7 冻结保留：fuse-trip 也冻真 failed", () => {
  it("fuse 熔断后本段真实 failed 的 id 也冻结（避免下段剩余子图重跑）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    // c spins with self-onFailure always failed (9th entry trips the fuse); d is
    // an ordinary edge-free node that really runs once in wave 0 and fails —
    // a true terminal outcome, not a cancel symptom.
    const pending = t.handler(
      {
        nodes: [
          { id: "c", task: "tc", onFailure: "c" },
          { id: "d", task: "td" },
        ],
      },
      { conversationId: CONV }
    );
    // Spawn order: wave 0 = c1, d1 (children 1-2); each later wave re-enters c
    // (c2..c8 = children 3-9, 8 entries total); c's 9th entry spawns nothing and trips.
    for (let entry = 1; entry <= 9; entry++) {
      await waitForChildren(children, entry);
      settle(children[entry - 1]!, fail("crashed"));
    }
    await expect(pending).rejects.toThrow(/effort fuse/);
    expect(children).toHaveLength(9);
    // A fuse trip is not a caller-side abort — genuinely failed ids in this
    // segment must freeze, otherwise the next residual-subgraph segment could
    // resubmit d / c and spawn again, violating ADR-0050.
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("d")).toBe("failed");
    expect(ledger.statusOf("c")).toBe("failed");
    await manager.shutdown();
  });
});

describe("run_graph effort fuse — 熔断时同波 in-flight 兄弟照实落定（不喂节点 signal）", () => {
  it("e 与第 9 进入同批且先 spawn：熔断后 e settle ok → e 落 done、冻结 done（不误标 failed、不丢）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const t = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });
    // Why this test is shaped like this: a same-batch Promise.all waits for
    // every node to settle, so an "in-flight sibling at trip time" can only be
    // in the **same batch** as the 9th entry, and its executor entry must
    // precede s(9) (after fuse abort, enter() is always false, so a node
    // entering after s(9) spawns zero and goes failed outright). Construction:
    //   - s (self-onFailure) spins once per wave (8 legal entries); its 9th
    //     entry trips in wave 8;
    //   - the done chain h1..h7→g delays e's deps promotion precisely to wave 8
    //     (g settles done in wave 7 → e is promoted);
    //   - s is last in the spec → within each wave's batch the done chain's
    //     promotion precedes s's self-kick → wave 8 batch = [e, s(9)], e spawns
    //     first (in-flight), s(9) trips the fuse right after.
    // fuse.signal feeds only the scheduler, never a node executor: e's
    // in-flight child is not interrupted; on settle ok it lands done by its
    // real outcome and freezes (same partial-results channel as the violation
    // path: freeze first, then typed rejection).
    const pending = t.handler(
      {
        nodes: [
          { id: "h1", task: "t1" },
          { id: "h2", task: "t2", deps: ["h1"] },
          { id: "h3", task: "t3", deps: ["h2"] },
          { id: "h4", task: "t4", deps: ["h3"] },
          { id: "h5", task: "t5", deps: ["h4"] },
          { id: "h6", task: "t6", deps: ["h5"] },
          { id: "h7", task: "t7", deps: ["h6"] },
          { id: "g", task: "tg", deps: ["h7"] },
          { id: "e", task: "te", deps: ["g"] },
          { id: "s", task: "ts", onFailure: "s" },
        ],
      },
      { conversationId: CONV }
    );
    // waves 0-6: each batch is [h(w+1), s(w+1)] (h's promotion precedes s's
    // self-kick). children[2w]=h(w+1), children[2w+1]=s(w+1). All h settle ok,
    // all s fail (s's 8 legal entries = children 1,3,5,7,9,11,13,15).
    for (let w = 0; w <= 6; w++) {
      await waitForChildren(children, 2 * w + 2);
      settle(children[2 * w]!, ok(`H${w + 1}`));
      settle(children[2 * w + 1]!, fail("crashed"));
    }
    // wave 7: [g, s(8)] (g promoted by h7). g ok, s(8) failed — s(8)'s
    // self-kick plus g's promotion of e assemble wave 8 as [e, s(9)].
    await waitForChildren(children, 16);
    settle(children[14]!, ok("G-OK"));
    settle(children[15]!, fail("crashed"));
    // wave 8: e spawns first (in-flight); s(9) is the 9th entry — fuse trips, zero spawn.
    await waitForChildren(children, 17);
    expect(children).toHaveLength(17);
    // e settles ok only after the trip — it must land done by its real outcome.
    settle(children[16]!, ok("E-OK"));
    await expect(pending).rejects.toThrow(/effort fuse/);
    const ledger = host.ledgerFor(CONV);
    expect(ledger.statusOf("e")).toBe("done");
    expect(ledger.isFrozen("e")).toBe(true);
    // s's spinning ends as a real failed (fuse trip ≠ cancel; failed freezes too).
    expect(ledger.statusOf("s")).toBe("failed");
    await manager.shutdown();
  }, 20_000);
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
