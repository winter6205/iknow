/**
 * run_graph handler wired to the ledger.
 *
 * Uses a real `SubAgentManager` (fake spawn + fake child, same pattern as
 * run-graph-executor.test.ts) — mocking the manager would mock away exactly
 * what is being verified: "the tool really drives spawn + the ledger really
 * blocks frozen ids".
 *
 * Five things:
 *   1. Fresh host + no calls → no ledger created;
 *   2. Invalid topology (cycle / self-dep / unknown dep / duplicate id /
 *      empty nodes) → typed rejection, zero spawns, still no ledger (the
 *      key boundary);
 *   3. First call that passes validation → ledgerFor(conv).exists() === true
 *      and the done ids of that call are in the frozen set;
 *   4. Resubmitting an already-frozen id → typed rejection, zero spawns;
 *      the ledger is unaffected by graph-mode toggling (host and
 *      graphAssembly hang off deps in parallel; toggling never destroys the
 *      ledger) — asserted as the composite "off → on → frozen id still
 *      rejected";
 *   5. Freeze seeding: a skipped id stays unfrozen (done/failed freeze,
 *      skipped does not), so a later resubmission really spawns.
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

const CONV = "conv-t1";

// ── When the ledger is created ─────────────────────────────────────────

describe("run_graph handler + ledger：SC1 账本创建时机", () => {
  it("host 新建 + 无任何调用 → 任何会话账本 exists() 为 false", () => {
    const host = createLiveGraphLedgerHost();
    expect(host.size()).toBe(0);
    expect(host.ledgerFor(CONV).exists()).toBe(false);
  });

  it("拓扑非法（环 / 自依赖 / 未知依赖 / 重复 id / 空 nodes）→ typed 拒绝 + 零 spawn + 账本仍未创建", async () => {
    const cases: Array<{
      readonly label: string;
      readonly input: unknown;
      readonly pattern: RegExp;
    }> = [
      {
        label: "环",
        input: {
          nodes: [
            { id: "a", task: "ta", deps: ["b"] },
            { id: "b", task: "tb", deps: ["a"] },
          ],
        },
        pattern: /cycle/,
      },
      {
        label: "自依赖",
        input: { nodes: [{ id: "a", task: "ta", deps: ["a"] }] },
        pattern: /depends on itself/,
      },
      {
        label: "未知依赖",
        input: { nodes: [{ id: "a", task: "ta", deps: ["ghost"] }] },
        pattern: /unknown node "ghost"/,
      },
      {
        label: "重复 id",
        input: {
          nodes: [
            { id: "a", task: "ta" },
            { id: "a", task: "tb" },
          ],
        },
        pattern: /duplicate node id/,
      },
      {
        label: "空 nodes",
        input: { nodes: [] },
        pattern: /non-empty array/,
      },
    ];
    for (const { input, pattern } of cases) {
      const { manager, children } = makeManager();
      const host = createLiveGraphLedgerHost();
      const tool = createRunGraphTool({
        manager,
        ledger: host,
        isEnabled: () => true,
      });
      await expect(tool.handler(input)).rejects.toThrow(ToolExecutionError);
      await expect(tool.handler(input)).rejects.toThrow(pattern);
      expect(children).toHaveLength(0);
      // Key boundary: validation failure must never create a ledger.
      expect(host.ledgerFor(CONV).exists()).toBe(false);
      await manager.shutdown();
    }
  });

  it("第一次校验通过的调用 → ledgerFor(conv).exists() === true + 冻结 done id", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );

    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));

    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.exists()).toBe(true);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a"]);
    await manager.shutdown();
  });

  it("两个节点一条边：上游 done + 下游 done 都冻结", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    const pending = tool.handler(
      {
        nodes: [
          { id: "u", task: "u" },
          { id: "d", task: "d", deps: ["u"] },
        ],
      },
      { conversationId: CONV }
    );

    await waitForChildren(children, 1);
    settle(children[0]!, ok("U"));
    await waitForChildren(children, 2);
    settle(children[1]!, ok("D"));

    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("u")).toBe(true);
    expect(ledger.isFrozen("d")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["u", "d"]);
    await manager.shutdown();
  });
});

// ── Turning the overlay off does not destroy the ledger ─────────────────

describe("run_graph handler + ledger：SC2 关 overlay 不毁账本", () => {
  it("账本建立后关掉 graph mode 再开：已冻结 id 仍被 typed 拒绝、零 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();

    // graphMode holder / graphAssembly hang off deps in parallel — flipping
    // graphAssembly.enabled() false / true leaves the ledger untouched.
    let graphOn = true;
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => graphOn,
    });

    // First graph run: completes → a is frozen.
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);

    // Overlay off → handler rejects (per the overlay gating behavior).
    graphOn = false;
    await expect(
      tool.handler(
        { nodes: [{ id: "b", task: "tb" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/graph mode is off/i);
    // Key: the ledger survives while the overlay is off.
    expect(host.ledgerFor(CONV).exists()).toBe(true);
    expect(host.ledgerFor(CONV).isFrozen("a")).toBe(true);

    // Overlay back on → resubmitting frozen a → typed rejection, zero spawns (the core promise).
    graphOn = true;
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler(
        { nodes: [{ id: "a", task: "ta-again" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(/frozen/i);
    expect(children).toHaveLength(childrenBefore);

    await manager.shutdown();
  });

  it("再交未冻结的 id：在已存在账本上继续走 done → 冻结追加", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // First segment: freeze a.
    const first = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await first;

    // Second segment: submit unfrozen b — real spawn (not the typed-rejection path of resubmitting a).
    const second = tool.handler(
      { nodes: [{ id: "b", task: "tb" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B"));
    await second;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.isFrozen("b")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
    await manager.shutdown();
  });
});

// ── Freeze seeding: done/failed freeze, skipped does not ───────────────

describe("run_graph handler + ledger：冻结语义种子（done 冻 / failed 冻 / skipped 不冻）", () => {
  it("failed id 同样冻结（spec Glossary：done/failed 均冻）", async () => {
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
    settle(children[0]!, fail("crashed"));
    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("boom")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["boom"]);

    // Resubmitting boom → typed rejection, zero spawns.
    const childrenBefore = children.length;
    await expect(
      tool.handler(
        { nodes: [{ id: "boom", task: "retry" }] },
        { conversationId: CONV }
      )
    ).rejects.toThrow(ToolExecutionError);
    expect(children).toHaveLength(childrenBefore);
    await manager.shutdown();
  });

  it("skipped id 未冻结（spec Glossary：skipped 不冻）→ 后续再交可 spawn", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Upstream fails → downstream is skipped.
    const pending = tool.handler(
      {
        nodes: [
          { id: "boom", task: "fail" },
          { id: "after", task: "needs boom", deps: ["boom"] },
        ],
      },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, fail("crashed"));
    await pending;

    const ledger = host.ledgerFor(CONV);
    expect(ledger.isFrozen("boom")).toBe(true);
    expect(ledger.isFrozen("after")).toBe(false);
    expect(ledger.frozenIds()).toEqual(["boom"]);

    // Resubmitting "after" (unfrozen) → real spawn.
    const second = tool.handler(
      { nodes: [{ id: "after", task: "retry" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("DONE"));
    await second;
    expect(ledger.isFrozen("after")).toBe(true);
    await manager.shutdown();
  });
});

// ── Regression without a host: zero behavior change for old callers ─────

describe("run_graph handler：未接 host 时零行为变化", () => {
  it("host 缺席 → 工具照常跑通、不冻结任何 id（不在账本位置报错）", async () => {
    const { manager, children } = makeManager();
    const tool = createRunGraphTool({ manager, isEnabled: () => true });

    const pending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A"));
    await pending;

    // No host: nothing freezes, the handler never throws — same behavior as before the ledger existed.
    expect(children).toHaveLength(1);
    await manager.shutdown();
  });
});
