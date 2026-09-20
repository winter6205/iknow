/**
 * New permission module — ask-user.test.ts.
 *
 * - createTtyAskUser uses readline against supplied streams (mocked).
 * - createFailClosedAskUser always returns false.
 * - createNoAskUser always returns true.
 * - createServeAskUser: FAIL-CLOSED after bounded timeout; only
 *   approves via resolveAsk(id, true). Replaces the prior auto-approve stub.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
  createServeAskUser,
} from "../../../src/harness/permission/ask-user.js";

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
    });
    assert.equal(r, true);
  });

  it("returns false on 'n' input", async () => {
    const stdin = Readable.from(["n\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(r, false);
  });

  it("returns false on EOF (fail-closed)", async () => {
    // Empty stdin → readline closes → fallback resolves false (fail-closed).
    const stdin = Readable.from([]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(r, false);
  });

  it("returns defaultYes=true when input is empty line", async () => {
    const stdin = Readable.from(["\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout, defaultYes: true });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
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
    } as Parameters<typeof a>[0]);

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
    });

    stdin.emit("error", new Error("stdin failed"));

    assert.equal(await p, false);
  });
});

describe("createServeAskUser (#115 H3: fail-closed)", () => {
  it("resolveAsk(id, true) approves a pending ask", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    const ctx = { tool: "bash", input: { command: "ls" }, summaryHint: "" };
    const p = h.ask(ctx);
    assert.equal(h.pendingCount(), 1);
    // Drain a microtask so the entry is committed before we settle.
    await Promise.resolve();
    const ok = h.resolveAsk("ask-1", true);
    assert.equal(ok, true);
    assert.equal(h.pendingCount(), 0);
    assert.equal(await p, true);
  });

  it("resolveAsk(id, false) denies a pending ask", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    const p = h.ask({ tool: "bash", input: {}, summaryHint: "" });
    await Promise.resolve();
    assert.equal(h.resolveAsk("ask-1", false), true);
    assert.equal(await p, false);
    assert.equal(h.pendingCount(), 0);
  });

  it("unresolved ask denies after timeout (fail-closed)", async () => {
    const h = createServeAskUser({ timeoutMs: 30 });
    const p = h.ask({ tool: "bash", input: {}, summaryHint: "" });
    assert.equal(h.pendingCount(), 1);
    const result = await p;
    assert.equal(result, false, "must fail-closed on timeout");
    assert.equal(h.pendingCount(), 0);
  });

  it("resolveAsk returns false for unknown / already-settled ids", async () => {
    const h = createServeAskUser({ timeoutMs: 30 });
    assert.equal(h.resolveAsk("ask-1", true), false, "no pending entry");
    const p = h.ask({ tool: "bash", input: {}, summaryHint: "" });
    await Promise.resolve();
    assert.equal(h.resolveAsk("ask-1", true), true);
    assert.equal(await p, true);
    // Already settled → subsequent resolveAsk is a no-op.
    assert.equal(h.resolveAsk("ask-1", true), false);
  });

  it("pendingCount reflects pending vs resolved lifecycle", async () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    assert.equal(h.pendingCount(), 0);
    const a = h.ask({ tool: "bash", input: {}, summaryHint: "" });
    const b = h.ask({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(h.pendingCount(), 2);
    await Promise.resolve();
    h.resolveAsk("ask-1", true);
    assert.equal(h.pendingCount(), 1);
    h.resolveAsk("ask-2", false);
    assert.equal(h.pendingCount(), 0);
    assert.equal(await a, true);
    assert.equal(await b, false);
  });

  it("does NOT auto-approve (regression — previous stub resolved true on microtask)", async () => {
    // Without resolveAsk the previous stub resolved true on the next microtask;
    // that auto-approve behavior is removed. We assert no auto-resolution
    // happens within a small window past the ask call (microtasks + setImmediate).
    const h = createServeAskUser({ timeoutMs: 50 });
    const p = h.ask({ tool: "bash", input: {}, summaryHint: "" });
    // Two microtasks + setImmediate — enough to expose any synchronous resolve.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
    // Still pending and not yet approved — only the timeout may settle it.
    assert.equal(h.pendingCount(), 1);
    const result = await p;
    assert.equal(result, false);
  });
});

describe("ServeAskUserHandle.pendingAll (commit B: web ask UI)", () => {
  it("empty when no asks in flight", () => {
    const h = createServeAskUser({ timeoutMs: 100 });
    assert.deepEqual([...h.pendingAll()], []);
  });

  it("lists pending ask with id + tool + summaryHint", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({
      tool: "bash",
      input: { command: "ls -la" },
      summaryHint: 'bash "ls -la"',
    });
    // Yield so the setTimeout is scheduled and the pending Map is populated.
    await Promise.resolve();
    const list = h.pendingAll();
    assert.equal(list.length, 1);
    const first = list[0]!;
    assert.match(first.id, /^ask-\d+$/);
    assert.equal(first.tool, "bash");
    assert.equal(first.summaryHint, 'bash "ls -la"');
    // Settle so the test process does not leak the timer.
    h.resolveAsk(first.id, true);
    await p;
  });

  it("pendingAll 视图字段集 = {id, tool, summaryHint}（输入侧额外 key 不外泄到视图）", async () => {
    // ADR-0097: the approval surface has exactly one chain; the view carries no
    // input-rewritten approval-axis fields. Even if input holds an unknown key
    // (e.g. the legacy network), the view field set stays fixed — the frontend
    // render surface therefore has no second marker branch.
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({
      tool: "bash",
      input: { command: "curl localhost", network: true },
      summaryHint: '{"command":"curl localhost"}',
    });
    await Promise.resolve();
    const list = h.pendingAll();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]!).sort(), [
      "id",
      "summaryHint",
      "tool",
    ]);
    assert.equal(list[0]!.tool, "bash");
    h.resolveAsk(list[0]!.id, true);
    await p;
  });

  it("clears entry after resolveAsk", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const p = h.ask({ tool: "write_file", input: {}, summaryHint: "wf" });
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
    const p = h.ask({ tool: "edit_file", input: {}, summaryHint: "e" });
    await Promise.resolve();
    assert.equal(h.pendingAll().length, 1);
    // Wait past the timeout.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.pendingAll().length, 0);
    assert.equal(await p, false);
  });

  it("resolveAsk after timeout returns false (no resurrection)", async () => {
    const h = createServeAskUser({ timeoutMs: 10 });
    const p = h.ask({ tool: "grep", input: {}, summaryHint: "g" });
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.resolveAsk(id, true), false);
    assert.equal(await p, false);
  });

  it("aborting a pending ask clears it and ignores a late approval", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
    } as Parameters<typeof h.ask>[0]);
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.equal(await p, false);
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
    } as Parameters<typeof h.ask>[0]);

    assert.equal(h.pendingCount(), 0);
    assert.equal(await p, false);
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
      } as Parameters<typeof h.ask>[0])
    );
    await Promise.resolve();
    assert.equal(h.pendingCount(), 3);

    controller.abort();

    assert.equal(h.pendingCount(), 0);
    assert.deepEqual(await Promise.all(asks), [false, false, false]);
  });

  it("an approval that settles first wins an abort race", async () => {
    const h = createServeAskUser({ timeoutMs: 1_000 });
    const controller = new AbortController();
    const p = h.ask({
      tool: "edit_file",
      input: {},
      summaryHint: "",
      signal: controller.signal,
    } as Parameters<typeof h.ask>[0]);
    await Promise.resolve();
    const id = h.pendingAll()[0]!.id;

    assert.equal(h.resolveAsk(id, true), true);
    controller.abort();

    assert.equal(await p, true);
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
