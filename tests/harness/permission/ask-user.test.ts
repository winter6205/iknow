/**
 * New permission module — ask-user.test.ts.
 *
 * - createTtyAskUser uses readline against supplied streams (mocked).
 * - createFailClosedAskUser always returns false.
 * - createNoAskUser always returns true.
 * - createServeAskUser: fail-closed — only an explicit approval admits a call,
 *   and there is NO default timeout (ADR-0147 R2/R4). resolveAsk(true/false)
 *   yields the approved/declined outcome, a configured `timeoutMs` yields
 *   `{kind:"timeout", afterMs}`, abort yields `{kind:"cancelled"}`.
 *
 * Every inlet input carries the call identity (ADR-0147 R1): required
 * `toolUseId`, optional `conversationId`.
 */

import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
  createServeAskUser,
} from "../../../src/harness/permission/ask-user.js";

afterEach(() => {
  vi.useRealTimers();
});

class MockWritable extends Writable {
  data = "";
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void
  ): void {
    this.data += chunk.toString();
    cb();
  }
}

describe("createFailClosedAskUser", () => {
  it("always returns false (deny)", async () => {
    const a = createFailClosedAskUser();
    const r = await a({
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "",
      toolUseId: "toolu_fail_closed",
    });
    assert.equal(r, false);
  });
});

describe("createNoAskUser", () => {
  it("always returns true (approve)", async () => {
    const a = createNoAskUser();
    const r = await a({
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "",
      toolUseId: "toolu_no_ask",
    });
    assert.equal(r, true);
  });
});

describe("createTtyAskUser", () => {
  it("returns true on 'y' input", async () => {
    const stdin = Readable.from(["y\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({
      tool: "edit_file",
      input: { path: "x.ts" },
      summaryHint: "",
      toolUseId: "toolu_tty_y",
    });
    assert.equal(r, true);
  });

  it("returns false on 'n' input", async () => {
    const stdin = Readable.from(["n\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_tty_n",
    });
    assert.equal(r, false);
  });

  it("returns false on EOF (fail-closed)", async () => {
    // Empty stdin → readline closes → fallback resolves false (fail-closed).
    const stdin = Readable.from([]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_tty_eof",
    });
    assert.equal(r, false);
  });

  it("returns defaultYes=true when input is empty line", async () => {
    const stdin = Readable.from(["\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout, defaultYes: true });
    const r = await a({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_tty_enter",
    });
    assert.equal(r, true);
  });

  it("prompt includes summaryHint when provided", async () => {
    const stdin = Readable.from(["n\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    await a({
      tool: "edit_file",
      input: { path: "/etc/passwd" },
      summaryHint: "edit /etc/passwd",
      toolUseId: "toolu_tty_hint",
    });
    assert.ok(stdout.data.includes("edit /etc/passwd"));
  });

  it("aborting a TTY ask resolves false without waiting for input", async () => {
    const stdin = new Readable({ read() {} });
    const stdout = new MockWritable();
    const controller = new AbortController();
    const a = createTtyAskUser({ stdin, stdout });
    const p = a({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_tty_abort",
    });

    controller.abort();

    assert.equal(await p, false);
    stdin.push("y\n");
  });

  it("TTY readline errors fail closed instead of rejecting", async () => {
    const stdin = new Readable({ read() {} });
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const p = a({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_tty_error",
    });

    stdin.emit("error", new Error("stdin failed"));

    assert.equal(await p, false);
  });

  it("serializes concurrent prompts — one typed answer settles only its own call (ADR-0127 H5)", async () => {
    // Two wait:false reviews relayed from subagents share this inlet.
    // Before the FIFO queue they each opened a readline on the same stdin
    // and a single `y` answered BOTH — breaking the one-call-scoped
    // approval contract (permission/security-review.ts).
    const stdin = new Readable({ read() {} });
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const first = a({
      tool: "edit_file",
      input: { path: "one" },
      summaryHint: "first-call",
      toolUseId: "toolu_tty_first",
    });
    const second = a({
      tool: "edit_file",
      input: { path: "two" },
      summaryHint: "second-call",
      toolUseId: "toolu_tty_second",
    });
    await new Promise((r) => setImmediate(r));
    // Sequential rendering: only the queued-first prompt has reached stdout.
    assert.ok(stdout.data.includes("first-call"));
    assert.ok(!stdout.data.includes("second-call"));

    stdin.push("y\n");
    assert.equal(await first, true);

    // The answer routed to the first call must not have settled the second.
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(secondSettled, false);
    assert.ok(stdout.data.includes("second-call"));

    // The second prompt is live and gets its own, separately typed answer.
    stdin.push("n\n");
    assert.equal(await second, false);
  });
});

describe("createServeAskUser (#115 H3: fail-closed)", () => {
  it("resolveAsk(id, true) approves a pending ask", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    const ctx = {
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "",
      toolUseId: "toolu_serve_approve",
    };
    const p = h.ask(ctx);
    assert.equal(h.pendingCount(), 1);
    // Drain a microtask so the entry is committed before we settle.
    await Promise.resolve();
    const ok = h.resolveAsk("ask-1", true);
    assert.equal(ok, true);
    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "approved" });
  });

  it("resolveAsk(id, false) denies a pending ask", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_serve_decline",
    });
    await Promise.resolve();
    assert.equal(h.resolveAsk("ask-1", false), true);
    assert.deepEqual(await p, { kind: "declined" });
    assert.equal(h.pendingCount(), 0);
  });

  it("an unanswered ask with a configured timeout ends as timeout (fail-closed)", async () => {
    vi.useFakeTimers();
    const h = createServeAskUser({ timeoutMs: 30 });
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_serve_timeout",
    });
    assert.equal(h.pendingCount(), 1);
    await vi.advanceTimersByTimeAsync(30);
    const result = await p;
    assert.deepEqual(result, { kind: "timeout", afterMs: 30 });
    assert.equal(h.pendingCount(), 0);
  });

  it("resolveAsk returns false for unknown / already-settled ids", async () => {
    const h = createServeAskUser({ timeoutMs: 30 });
    assert.equal(h.resolveAsk("ask-1", true), false, "no pending entry");
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_serve_unknown",
    });
    await Promise.resolve();
    assert.equal(h.resolveAsk("ask-1", true), true);
    assert.deepEqual(await p, { kind: "approved" });
    // Already settled → subsequent resolveAsk is a no-op.
    assert.equal(h.resolveAsk("ask-1", true), false);
  });

  it("pendingCount reflects pending vs resolved lifecycle", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    assert.equal(h.pendingCount(), 0);
    const a = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_lifecycle_1",
    });
    const b = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_lifecycle_2",
    });
    assert.equal(h.pendingCount(), 2);
    await Promise.resolve();
    h.resolveAsk("ask-1", true);
    assert.equal(h.pendingCount(), 1);
    h.resolveAsk("ask-2", false);
    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await a, { kind: "approved" });
    assert.deepEqual(await b, { kind: "declined" });
  });

  it("does NOT auto-approve (regression — previous stub resolved true on microtask)", async () => {
    // Without resolveAsk the previous stub resolved true on the next microtask;
    // that auto-approve behavior is removed. We assert no auto-resolution
    // happens within a small window past the ask call (microtasks + setImmediate).
    const h = createServeAskUser({ timeoutMs: 50 });
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_no_auto",
    });
    // Two microtasks + setImmediate — enough to expose any synchronous resolve.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
    // Still pending and not yet approved — only the timeout may settle it.
    assert.equal(h.pendingCount(), 1);
    const result = await p;
    assert.deepEqual(result, { kind: "timeout", afterMs: 50 });
  });
});

describe("createServeAskUser — no default timeout (ADR-0147 R4)", () => {
  it("an unconfigured handle is still pending after 5s and 10 minutes", async () => {
    vi.useFakeTimers();
    const h = createServeAskUser();
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_wait_forever",
    });
    assert.equal(h.pendingCount(), 1);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(h.pendingCount(), 1, "no 5s default timer");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    assert.equal(h.pendingCount(), 1, "no 60s default timer either");
    const id = h.pendingAll()[0]!.id;
    assert.equal(h.resolveAsk(id, true), true);
    assert.deepEqual(await p, { kind: "approved" });
  });

  it("timeoutMs: 0 is the same as absent — no timer", async () => {
    vi.useFakeTimers();
    const h = createServeAskUser({ timeoutMs: 0 });
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_zero_timeout",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    assert.equal(h.pendingCount(), 1);
    h.resolveAsk(h.pendingAll()[0]!.id, false);
    assert.deepEqual(await p, { kind: "declined" });
  });

  it("a configured timeout ends the ask after exactly its budget, carrying afterMs", async () => {
    vi.useFakeTimers();
    const h = createServeAskUser({ timeoutMs: 2_500 });
    const p = h.ask({
      tool: "bash",
      input: {},
      summaryHint: "",
      toolUseId: "toolu_configured_timeout",
    });
    await vi.advanceTimersByTimeAsync(2_499);
    assert.equal(h.pendingCount(), 1, "not early");
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(await p, { kind: "timeout", afterMs: 2_500 });
    assert.equal(h.pendingCount(), 0);
  });

  it("abort ends a pending ask as cancelled with a configured timeout", async () => {
    const h = createServeAskUser({ timeoutMs: 60_000 });
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_abort_configured",
    });
    await Promise.resolve();
    assert.equal(h.pendingCount(), 1);

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
  });

  it("abort ends a pending ask as cancelled with no configured timeout", async () => {
    const h = createServeAskUser();
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_abort_unconfigured",
    });
    await Promise.resolve();
    assert.equal(h.pendingCount(), 1);

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
  });

  it("an already-aborted signal yields cancelled with a configured timeout and creates no entry", async () => {
    const h = createServeAskUser({ timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();

    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_preaborted_configured",
    });

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
  });

  it("an already-aborted signal yields cancelled with no configured timeout", async () => {
    const h = createServeAskUser();
    const controller = new AbortController();
    controller.abort();

    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_preaborted_unconfigured",
    });

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
  });
});

describe("ServeAskUserHandle.pendingAll (commit B: web ask UI)", () => {
  it("empty when no asks in flight", () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    assert.deepEqual([...h.pendingAll()], []);
  });

  it("lists pending ask with id + tool + summaryHint + call identity", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({
      tool: "bash",
      input: { command: "ls -la" },
      summaryHint: 'bash "ls -la"',
      toolUseId: "toolu_view_1",
      conversationId: "conv-42",
    });
    // Yield so the setTimeout is scheduled and the pending Map is populated.
    await Promise.resolve();
    const list = h.pendingAll();
    assert.equal(list.length, 1);
    const first = list[0]!;
    assert.match(first.id, /^ask-\d+$/);
    assert.equal(first.tool, "bash");
    assert.equal(first.summaryHint, 'bash "ls -la"');
    assert.equal(first.toolUseId, "toolu_view_1");
    assert.equal(first.conversationId, "conv-42");
    // Settle so the test process does not leak the timer.
    h.resolveAsk(first.id, true);
    await p;
  });

  it("pendingAll 视图字段集 = {id, tool, summaryHint, toolUseId} when the caller has no conversation（输入侧额外 key 不外泄到视图）", async () => {
    // ADR-0097: the approval surface has exactly one chain; the view carries no
    // input-rewritten approval-axis fields. Even if input holds an unknown key
    // (e.g. the legacy network), the view field set stays fixed — the frontend
    // render surface therefore has no second marker branch.
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({
      tool: "bash",
      input: { command: "curl localhost", network: true },
      summaryHint: '{"command":"curl localhost"}',
      toolUseId: "toolu_view_2",
    });
    await Promise.resolve();
    const list = h.pendingAll();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]!).sort(), [
      "id",
      "summaryHint",
      "tool",
      "toolUseId",
    ]);
    assert.equal(list[0]!.tool, "bash");
    assert.equal(list[0]!.conversationId, undefined);
    h.resolveAsk(list[0]!.id, true);
    await p;
  });

  it("clears entry after resolveAsk", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({
      tool: "write_file",
      input: {},
      summaryHint: "wf",
      toolUseId: "toolu_clear",
    });
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;
    assert.equal(h.pendingCount(), 1);
    const ok = h.resolveAsk(id, true);
    assert.equal(ok, true);
    assert.equal(h.pendingCount(), 0);
    assert.equal(h.pendingAll().length, 0);
    await p;
  });

  it("returns empty after timeout settles (fail-closed)", async () => {
    const h = createServeAskUser({ timeoutMs: 10 });
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "e",
      toolUseId: "toolu_after_timeout",
    });
    await Promise.resolve();
    assert.equal(h.pendingAll().length, 1);
    // Wait past the timeout.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.pendingAll().length, 0);
    assert.deepEqual(await p, { kind: "timeout", afterMs: 10 });
  });

  it("resolveAsk after timeout returns false and the promise stays timeout (no resurrection)", async () => {
    const h = createServeAskUser({ timeoutMs: 10 });
    const p = h.ask({
      tool: "grep",
      input: {},
      summaryHint: "g",
      toolUseId: "toolu_no_resurrection",
    });
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.resolveAsk(id, true), false);
    assert.deepEqual(await p, { kind: "timeout", afterMs: 10 });
  });

  it("aborting a pending ask clears it and ignores a late approval", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_late_approval",
    } as Parameters<typeof h.ask>[0]);
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
    assert.equal(h.resolveAsk(id, true), false);
  });

  it("an already-aborted signal does not create a pending ask", async () => {
    const h = createServeAskUser({ timeoutMs: 10 });
    const controller = new AbortController();
    controller.abort();

    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_pending_none",
    } as Parameters<typeof h.ask>[0]);

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await p, { kind: "cancelled" });
  });

  it("aborting one signal clears multiple pending asks", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const asks = [1, 2, 3].map((n) =>
      h.ask({
        tool: `tool-${n}`,
        input: {},
        summaryHint: "",
        signal: controller.signal,
        toolUseId: `toolu_multi_${n}`,
      } as Parameters<typeof h.ask>[0])
    );
    await Promise.resolve();
    assert.equal(h.pendingCount(), 3);

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await Promise.all(asks), [
      { kind: "cancelled" },
      { kind: "cancelled" },
      { kind: "cancelled" },
    ]);
  });

  it("an approval that settles first wins an abort race", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
      toolUseId: "toolu_race",
    } as Parameters<typeof h.ask>[0]);
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;

    assert.equal(h.resolveAsk(id, true), true);
    controller.abort();

    assert.deepEqual(await p, { kind: "approved" });
    assert.equal(h.pendingCount(), 0);
  });

  it("aborting with no pending asks is a no-op", () => {
    const h = createServeAskUser({ timeoutMs: 10 });
    const controller = new AbortController();

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(h.pendingAll(), []);
  });
});
