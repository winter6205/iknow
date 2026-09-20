/**
 * Handler-level host isolation / anonymous-ledger path boundaries.
 *
 * Covers the two real boundaries at the handler entry point (the host unit
 * layer is covered in `tests/harness/graph/live-graph-ledger.test.ts`, but
 * the handler's wiring through `mergeResidual` / `ensure` / `freezeResults`
 * is a separate contract — this file only fills that wiring gap, with zero
 * source changes):
 *
 *   1. **Cross-session isolation**: one host carrying two conversationIds —
 *      their freezes are mutually invisible.
 *   2. **`conversationId === undefined` lands in the anonymous ledger**:
 *      direct/stub handler calls still freeze, and the frozen set does not
 *      pollute other sessions (host-level `size()` excludes the anonymous
 *      ledger, but freezing itself still takes effect).
 *   3. **Missing `nodes` root field**: the handler rejects with a typed
 *      error and zero spawns (same EXIT category as "empty nodes" /
 *      "unknown node", but via a missing root field rather than a wrong one).
 *
 * Uses a real `SubAgentManager` (fake spawn + fake child), same pattern as
 * `run-graph-ledger.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import { createLiveGraphLedgerHost } from "../../../src/harness/graph/ledger.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { makeManager, settle, ok, waitForChildren } from "./_fake-manager.ts";

const CONV_A = "conv-A-isolation";
const CONV_B = "conv-B-isolation";

describe("run_graph handler：host 跨会话隔离", () => {
  it("同一 host 上两个 conversationId 的冻结互不污染（handler 级接线）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Freeze "a" under conv-A.
    const aPending = tool.handler(
      { nodes: [{ id: "a", task: "ta" }] },
      { conversationId: CONV_A }
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("A-OUT"));
    await aPending;

    // Freeze "b" under conv-B — shared host, separate ledgers.
    const bPending = tool.handler(
      { nodes: [{ id: "b", task: "tb" }] },
      { conversationId: CONV_B }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("B-OUT"));
    await bPending;

    expect(host.size()).toBe(2);
    const aLedger = host.ledgerFor(CONV_A);
    const bLedger = host.ledgerFor(CONV_B);
    expect(aLedger.isFrozen("a")).toBe(true);
    expect(aLedger.isFrozen("b")).toBe(false);
    expect(bLedger.isFrozen("b")).toBe(true);
    expect(bLedger.isFrozen("a")).toBe(false);

    // Resubmitting an id that is frozen only in the other session must not be
    // rejected: "a" frozen in conv-A does not exist for conv-B. The same id
    // settling independently per session is exactly the isolation promise.
    await manager.shutdown();
  });
});

describe("run_graph handler：conversationId undefined 匿名账本", () => {
  it("ctx.conversationId 缺席 → 落到 host 共享匿名账本，冻结生效且不污染其它会话", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // 1) Anonymous-ledger path (common for direct handler / stub calls).
    const anonPending = tool.handler(
      { nodes: [{ id: "x", task: "tx" }] }
      // no ctx passed → conversationId === undefined
    );
    await waitForChildren(children, 1);
    settle(children[0]!, ok("X-OUT"));
    await anonPending;

    const anon = host.ledgerFor(undefined);
    expect(anon.isFrozen("x")).toBe(true);
    expect(anon.outputOf("x")).toBe("X-OUT");
    // The anonymous ledger is not counted in size().
    expect(host.size()).toBe(0);

    // 2) The same id is unfrozen in a named session (isolation).
    const aPending = tool.handler(
      { nodes: [{ id: "x", task: "tx-again" }] },
      { conversationId: CONV_A }
    );
    await waitForChildren(children, 2);
    settle(children[1]!, ok("X2-OUT"));
    await aPending;
    expect(host.ledgerFor(CONV_A).isFrozen("x")).toBe(true);
    expect(host.size()).toBe(1);

    await manager.shutdown();
  });

  it("缺 nodes 根字段：handler typed 拒绝、零 spawn（根字段缺失 EXIT）", async () => {
    const { manager, children } = makeManager();
    const host = createLiveGraphLedgerHost();
    const tool = createRunGraphTool({
      manager,
      ledger: host,
      isEnabled: () => true,
    });

    // Direct handler call: root field missing (not a wrong-named root, not an empty array).
    await expect(
      tool.handler({} as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({} as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(/non-empty array/i);

    // An explicitly undefined nodes is rejected like an empty array.
    await expect(
      tool.handler({ nodes: undefined } as Record<string, unknown>, {
        conversationId: CONV_A,
      })
    ).rejects.toThrow(/non-empty array/i);

    expect(children).toHaveLength(0);
    // Validation failure must never create a ledger (consistent with run-graph-ledger.test.ts).
    expect(host.ledgerFor(CONV_A).exists()).toBe(false);
    await manager.shutdown();
  });
});
