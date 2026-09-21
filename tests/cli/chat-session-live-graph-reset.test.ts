/**
 * CLI `/reset` destroys the live-graph ledger.
 *
 * Command-handler integration discipline (`.claude/rules/test.md`): a real
 * SessionStore (temp dir) plus a real fresh conversationId (no pre-stored
 * session file), driven through `processChatLine`'s slash path —— a pure
 * applySlashCommand bus test cannot reach `ctx.liveGraphLedger` /
 * `ctx.state.conversationId` and would miss the real destruction boundary.
 *
 * Three things:
 *   1. the ledger exists (seeded by hand to simulate an earlier run_graph ——
 *      the handler wiring that builds it is covered by
 *      run-graph-ledger.test.ts, so only the destruction timing is proved
 *      here);
 *   2. after `/reset` the ledger for that conversationId is gone: the old id is
 *      no longer frozen and `exists()` is false again —— the next run_graph can
 *      reuse the old id and really spawn;
 *   3. conversationId null (fresh REPL, no query line yet) → /reset does not
 *      throw (a typed legal state, not an error).
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { processChatLine } from "../../src/cli/chat-session.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createLiveGraphLedgerHost } from "../../src/harness/graph/ledger.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

const tempDirs: string[] = [];
function storeFor(): SessionStore {
  const tmp = mkdtempSync(join(tmpdir(), "iknow-graph-reset-"));
  tempDirs.push(tmp);
  return new SessionStore(tmp, process.cwd());
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("CLI /reset — 活图账本销毁（SC3）", () => {
  it("reset 后同一 conversationId 的账本被销毁：旧 id 不再冻结", async () => {
    const convId = randomUUID();
    const host = createLiveGraphLedgerHost();
    // Simulate "a previous run_graph already built and froze the ledger"
    // (the handler wiring has its own integration test).
    const ledger = host.ledgerFor(convId);
    ledger.ensure();
    ledger.freeze("old-id", "done");
    expect(ledger.isFrozen("old-id")).toBe(true);

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      stateOverrides: { conversationId: convId },
    });
    ctx.liveGraphLedger = host;

    const result = await processChatLine({ line: "/reset", ctx });
    expect(result.quit).toBe(false);
    expect(result.output).toBe("Session cleared.");

    // After destruction: exists is false and the old id is unfrozen —— the next
    // run_graph may reuse it and really spawn.
    expect(host.size()).toBe(0);
    const fresh = host.ledgerFor(convId);
    expect(fresh.exists()).toBe(false);
    expect(fresh.isFrozen("old-id")).toBe(false);
  });

  it("conversationId 为 null（fresh REPL 未跑过查询行）→ /reset 不抛（typed 合法态）", async () => {
    const host = createLiveGraphLedgerHost();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
    });
    ctx.liveGraphLedger = host;
    expect(ctx.state.conversationId).toBeNull();

    const result = await processChatLine({ line: "/reset", ctx });
    expect(result.quit).toBe(false);
    expect(result.output).toBe("Session cleared.");
    expect(host.size()).toBe(0);
  });

  it("liveGraphLedger 缺席（ask / 未接活图）→ /reset 零行为变化", async () => {
    const store = storeFor();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      stateOverrides: { conversationId: randomUUID() },
      checkpointStore: store,
    });
    const result = await processChatLine({ line: "/reset", ctx });
    expect(result.quit).toBe(false);
    expect(result.output).toBe("Session cleared.");
  });

  it("真实 store + fresh conversationId：reset 前后 message 状态照旧（回归锚）", async () => {
    const convId = randomUUID();
    const store = storeFor();
    const host = createLiveGraphLedgerHost();
    host.ledgerFor(convId).ensure();

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer"] })],
      stateOverrides: { conversationId: convId },
      checkpointStore: store,
    });
    ctx.liveGraphLedger = host;

    // One real query line (write to disk → reset → messages cleared, ledger
    // destroyed).
    const ran = await processChatLine({ line: "hello", ctx });
    expect(ran.quit).toBe(false);
    expect(ctx.state.messages.length).toBeGreaterThan(0);
    expect(host.ledgerFor(convId).exists()).toBe(true);

    await processChatLine({ line: "/reset", ctx });
    expect(ctx.state.messages.length).toBe(0);
    expect(host.size()).toBe(0);
    expect(host.ledgerFor(convId).exists()).toBe(false);
  });
});
