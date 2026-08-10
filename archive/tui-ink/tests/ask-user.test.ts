/**
 * tests/tui/ask-user.test.ts
 *
 * #146 TUI askUser 桥接：queue-based + fail-closed 纪律（仿 serve #115 H3）。
 * 覆盖：approve/deny 显式 resolve、超时 fail-closed、未知 id、pending 投影。
 */
import { describe, expect, it, vi } from "vitest";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";

const ctx = { tool: "bash", input: { command: "ls" }, summaryHint: "ls" };

describe("createTuiAskUserBridge", () => {
  it("resolveAsk(true) → ask 放行", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(ctx);
    expect(bridge.pendingCount()).toBe(1);
    const pending = bridge.pending();
    expect(pending?.tool).toBe("bash");
    expect(bridge.resolveAsk(pending!.id, true)).toBe(true);
    await expect(promise).resolves.toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("resolveAsk(false) → ask 拒绝", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(ctx);
    const id = bridge.pending()!.id;
    expect(bridge.resolveAsk(id, false)).toBe(true);
    await expect(promise).resolves.toBe(false);
  });

  it("超时 fail-closed（无显式 resolve → false）", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createTuiAskUserBridge({ timeoutMs: 50 });
      const promise = bridge.ask(ctx);
      vi.advanceTimersByTime(60);
      await expect(promise).resolves.toBe(false);
      expect(bridge.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未知/已决 id → resolveAsk 返回 false", async () => {
    const bridge = createTuiAskUserBridge();
    const promise = bridge.ask(ctx);
    const id = bridge.pending()!.id;
    bridge.resolveAsk(id, true);
    await promise;
    expect(bridge.resolveAsk(id, true)).toBe(false);
    expect(bridge.resolveAsk("ask-nope", true)).toBe(false);
  });

  it("多个 ask 排队：pending() 返回最早一个（FIFO）", async () => {
    const bridge = createTuiAskUserBridge();
    const p1 = bridge.ask(ctx);
    const p2 = bridge.ask({ ...ctx, tool: "write_file" });
    expect(bridge.pendingCount()).toBe(2);
    expect(bridge.pending()?.tool).toBe("bash");
    const id1 = bridge.pending()!.id;
    bridge.resolveAsk(id1, true);
    await p1;
    expect(bridge.pending()?.tool).toBe("write_file");
    const id2 = bridge.pending()!.id;
    bridge.resolveAsk(id2, false);
    await p2;
  });

  it("subscribe：enqueue / settle 各推送一次；退订后不再通知（#279 项3）", async () => {
    const bridge = createTuiAskUserBridge();
    let calls = 0;
    const unsub = bridge.subscribe(() => {
      calls += 1;
    });
    const promise = bridge.ask(ctx); // enqueue → +1
    expect(calls).toBe(1);
    const id = bridge.pending()!.id;
    bridge.resolveAsk(id, true); // settle → +1
    await promise;
    expect(calls).toBe(2);
    unsub();
    const p2 = bridge.ask(ctx); // 退订后不再通知
    bridge.resolveAsk(bridge.pending()!.id, false);
    await p2;
    expect(calls).toBe(2);
  });
});
