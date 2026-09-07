/**
 * live-graph-phase1 T1 — CLI `/reset` 销毁活图账本（SC3）。
 *
 * 命令 handler 集成测试纪律（.claude/rules/test.md）：接真实 SessionStore
 * （temp dir）+ 真实 fresh conversationId（不预存 session 文件），走
 * `processChatLine` 的 slash 路径 —— 纯 applySlashCommand 总线测试拿不到
 * `ctx.liveGraphLedger` / `ctx.state.conversationId`，会漏掉 reset 的真实
 * 销毁边界。
 *
 * 三件事：
 *   1. 账本建立（先手工 ensure 模拟"之前跑过 run_graph"—— handler 建
 *      账的接线由 run-graph-ledger.test.ts 覆盖，这里只证销毁时机）；
 *   2. `/reset` 之后同一 conversationId 的账本已销毁：旧 id 不再冻结、
 *      `exists()` 回 false —— 下一次 run_graph 可重用旧 id 真正 spawn；
 *   3. conversationId 为 null（fresh REPL 尚未跑过查询行）→ /reset 不抛
 *      （typed 合法态，不是错误）。
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
  return new SessionStore(tmp);
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("CLI /reset — 活图账本销毁（SC3）", () => {
  it("reset 后同一 conversationId 的账本被销毁：旧 id 不再冻结", async () => {
    const convId = randomUUID();
    const host = createLiveGraphLedgerHost();
    // 模拟"此前 run_graph 已建账并冻结"（handler 接线另有集成测试）。
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

    // 销毁之后：exists 回 false，旧 id 不再冻结 —— 下一次 run_graph 可
    // 重用旧 id 真正 spawn（SC3 的可观察行为）。
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

    // 跑一条真实查询行（落盘 → reset → messages 清空、账本销毁）。
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
