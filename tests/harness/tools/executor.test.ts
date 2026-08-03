/**
 * T3 Executor:串行 / 无短路 / 无自动重试。
 *
 * 015 强制:按 assistant content blocks 中 tool calls 出现顺序串行执行;
 * 某个调用失败不短路该回合剩余调用;失败立即回填,不自动重试;严格校验
 * 失败时不调用工具,只形成可修正 ToolExecutionResult。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { toAnthropicToolResults } from "../../../src/harness/tools/tool-result.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";

const echo: ToolDef = {
  name: "echo",
  description: "echo",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  handler: (i: unknown) => i,
};

const boom: ToolDef = {
  name: "boom",
  description: "throws",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { x: { type: "number" } },
    required: ["x"],
  },
  handler: () => {
    throw new Error("kaboom");
  },
};

describe("createExecutor (T3)", () => {
  it("executes a single call successfully and returns matched identity", async () => {
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "c1", name: "echo", input: { value: "hi" } },
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.kind, "ok");
    assert.equal(results[0]!.toolUseId, "c1");
    assert.deepEqual(results[0]!.payload, [
      { type: "text", text: '{"value":"hi"}' },
    ]);
  });

  it("returns tool_not_found for missing tool, never throws", async () => {
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "c1", name: "missing", input: {} },
    ]);
    assert.equal(results[0]!.kind, "tool_not_found");
    assert.equal(results[0]!.toolUseId, "c1");
  });

  it("returns validation_failed for bad input (does not call handler)", async () => {
    let called = false;
    const strict: ToolDef = {
      name: "strict",
      description: "strict",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "integer" } },
        required: ["n"],
      },
      handler: () => {
        called = true;
        return { ok: true };
      },
    };
    const reg = createRegistry([strict]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "c1", name: "strict", input: { n: "not-a-number" } },
    ]);
    assert.equal(results[0]!.kind, "validation_failed");
    assert.equal(called, false);
  });

  it("returns execution_failed (sanitized) for unexpected throws", async () => {
    const reg = createRegistry([boom]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "c1", name: "boom", input: { x: 1 } },
    ]);
    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(results[0]!.toolUseId, "c1");
    // safety: must not leak raw Error message
    assert.equal(
      results[0]!.kind === "execution_failed" &&
        !/kaboom/i.test(results[0]!.message),
      true
    );
  });

  it("serial multi-call: 3 calls executed in declared order, results aligned", async () => {
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const calls = [
      { id: "a", name: "echo", input: { value: "1" } },
      { id: "b", name: "echo", input: { value: "2" } },
      { id: "c", name: "echo", input: { value: "3" } },
    ];
    const results = await exec.executeAll(calls);
    assert.deepEqual(
      results.map((r) => r.kind === "ok" && r.toolUseId),
      ["a", "b", "c"]
    );
  });

  it("no-shortcircuit: failure in call #2 does not skip call #3", async () => {
    const reg = createRegistry([echo, boom]);
    const exec = createExecutor(reg);
    const calls = [
      { id: "a", name: "echo", input: { value: "1" } },
      { id: "b", name: "boom", input: { x: 1 } },
      { id: "c", name: "echo", input: { value: "3" } },
    ];
    const results = await exec.executeAll(calls);
    assert.equal(results.length, 3);
    assert.equal(results[0]!.kind, "ok");
    assert.equal(results[1]!.kind, "execution_failed");
    assert.equal(results[2]!.kind, "ok");
  });
});

describe("createExecutor (017 signal/timeout)", () => {
  it("timeout: handler slower than timeoutMs -> execution_failed with message containing timeout", async () => {
    const slow: ToolDef = {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () =>
        new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 100)),
    };
    const exec = createExecutor(createRegistry([slow]));
    const results = await exec.executeAll(
      [{ id: "c1", name: "slow", input: {} }],
      undefined,
      10
    );

    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(
      results[0]!.kind === "execution_failed" &&
        /timeout/.test(results[0]!.message),
      true
    );
  });

  it("ctx.signal passthrough: handler receives a signal that reflects outer abort (T2 unified signal)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let capturedAbortedAfter: boolean | undefined;
    const capture: ToolDef = {
      name: "capture",
      description: "capture signal",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) => {
        capturedSignal = ctx?.signal;
        ctx?.signal?.addEventListener("abort", () => {
          capturedAbortedAfter = ctx?.signal?.aborted;
        });
        return { ok: true };
      },
    };
    const exec = createExecutor(createRegistry([capture]));
    const controller = new AbortController();

    const pending = exec.executeAll(
      [{ id: "c1", name: "capture", input: {} }],
      controller.signal
    );

    controller.abort();
    await pending;

    // T2: ctx.signal is a unified signal (not necessarily same identity as outer),
    // but it MUST reflect outer abort state.
    assert.equal(capturedSignal !== undefined, true);
    assert.equal(capturedSignal!.aborted, true);
    assert.equal(capturedAbortedAfter, true);
  });

  it('abort: handler throws AbortError after abort -> execution_failed with message "cancelled"', async () => {
    const abortable: ToolDef = {
      name: "abortable",
      description: "abortable",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          });
        }),
    };
    const exec = createExecutor(createRegistry([abortable]));
    const controller = new AbortController();
    const pending = exec.executeAll(
      [{ id: "c1", name: "abortable", input: {} }],
      controller.signal
    );

    controller.abort();
    const results = await pending;

    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(
      results[0]!.kind === "execution_failed" && results[0]!.message,
      "cancelled"
    );
  });
});

describe("createExecutor (T2 unified stop signal)", () => {
  it("timeout fires: handler receives ctx.signal with aborted=true (signal delivered, not only wait race)", async () => {
    let observedSignal: AbortSignal | undefined;
    let observedAtAbort: boolean | undefined;
    const slow: ToolDef = {
      name: "slow-observer",
      description: "observes ctx.signal on timeout",
      inputSchema: { type: "object", additionalProperties: false },
      // Handler never resolves/rejects; it just records that the signal fires.
      // executor's timeout child.abort() + reject(TIMEOUT) wins the race.
      handler: (_input, ctx) =>
        new Promise(() => {
          observedSignal = ctx?.signal;
          ctx?.signal?.addEventListener("abort", () => {
            observedAtAbort = ctx?.signal?.aborted;
          });
        }),
    };
    const exec = createExecutor(createRegistry([slow]));
    const results = await exec.executeAll(
      [{ id: "c1", name: "slow-observer", input: {} }],
      undefined,
      15
    );

    // Signal delivery proof (T2): ctx.signal is unified, and aborted=true
    // when the timeout timer fires child.abort().
    assert.equal(observedSignal !== undefined, true);
    assert.equal(observedSignal!.aborted, true);
    assert.equal(observedAtAbort, true);
    // Executor still produces "timeout" message (loop-engine string contract).
    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(
      results[0]!.kind === "execution_failed" && results[0]!.message,
      "timeout"
    );
  });

  it("caller abort: handler receives ctx.signal with aborted=true (signal delivered on outer cancel)", async () => {
    let observedAtAbort: boolean | undefined;
    const cancellable: ToolDef = {
      name: "cancel-observer",
      description: "observes ctx.signal on cancel",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            observedAtAbort = ctx?.signal?.aborted;
            reject(new Error("cancelled-by-handler"));
          });
        }),
    };
    const exec = createExecutor(createRegistry([cancellable]));
    const controller = new AbortController();
    const pending = exec.executeAll(
      [{ id: "c1", name: "cancel-observer", input: {} }],
      controller.signal
    );

    controller.abort();
    const results = await pending;

    assert.equal(observedAtAbort, true);
    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(
      results[0]!.kind === "execution_failed" && results[0]!.message,
      "cancelled"
    );
  });

  it("caller abort priority: abort wins over timeout -> message exactly 'cancelled'", async () => {
    // Handler waits on ctx.signal abort; if executor races timer correctly,
    // abort always wins (caller abort pre-empts timeout).
    const both: ToolDef = {
      name: "both",
      description: "responds to abort",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () =>
            reject(new Error("observed-abort"))
          );
          setTimeout(() => {
            /* never resolves */
          }, 200);
        }),
    };
    const exec = createExecutor(createRegistry([both]));
    const controller = new AbortController();
    const pending = exec.executeAll(
      [{ id: "c1", name: "both", input: {} }],
      controller.signal,
      200
    );

    controller.abort();
    const results = await pending;

    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(
      results[0]!.kind === "execution_failed" && results[0]!.message,
      "cancelled"
    );
  });

  it("no timeoutMs and no caller signal: ctx.signal is undefined (passthrough preserved)", async () => {
    let observedSignal: AbortSignal | undefined;
    let observedSignalSeen = false;
    const capture: ToolDef = {
      name: "capture",
      description: "capture ctx.signal",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) => {
        observedSignalSeen = true;
        observedSignal = ctx?.signal;
        return { ok: true };
      },
    };
    const exec = createExecutor(createRegistry([capture]));
    await exec.executeAll([{ id: "c1", name: "capture", input: {} }]);

    assert.equal(observedSignalSeen, true);
    assert.equal(observedSignal, undefined);
  });

  it("no timeoutMs but caller signal present: handler receives a signal that mirrors caller abort", async () => {
    let observedAtAbort: boolean | undefined;
    const passthrough: ToolDef = {
      name: "passthrough",
      description: "responds to outer abort",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            observedAtAbort = ctx?.signal?.aborted;
            reject(new Error("aborted-by-handler"));
          });
        }),
    };
    const exec = createExecutor(createRegistry([passthrough]));
    const controller = new AbortController();
    const pending = exec.executeAll(
      [{ id: "c1", name: "passthrough", input: {} }],
      controller.signal
    );

    controller.abort();
    const results = await pending;

    assert.equal(observedAtAbort, true);
    assert.equal(
      results[0]!.kind === "execution_failed" && results[0]!.message,
      "cancelled"
    );
  });
});

describe("createExecutor (T3 JSON whitelist + 20000 cap)", () => {
  // ---- T3 Part A: isJsonCompatible strict whitelist ----

  it("rejects NaN (does not silently coerce to null via JSON.stringify)", async () => {
    const bad: ToolDef = {
      name: "bad-nan",
      description: "NaN in payload",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({ v: Number.NaN }),
    };
    const exec = createExecutor(createRegistry([bad]));
    const results = await exec.executeAll([
      { id: "c1", name: "bad-nan", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    assert.deepEqual(results[0]!.kind === "ok" && results[0]!.payload, [
      { type: "text", text: "[executor: payload not JSON-compatible]" },
    ]);
  });

  it("rejects Infinity / -Infinity", async () => {
    const bad: ToolDef = {
      name: "bad-inf",
      description: "Infinity in payload",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({
        pos: Number.POSITIVE_INFINITY,
        neg: Number.NEGATIVE_INFINITY,
      }),
    };
    const exec = createExecutor(createRegistry([bad]));
    const results = await exec.executeAll([
      { id: "c1", name: "bad-inf", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    assert.deepEqual(results[0]!.kind === "ok" && results[0]!.payload, [
      { type: "text", text: "[executor: payload not JSON-compatible]" },
    ]);
  });

  it("rejects Date / Map / Set / class instances (strict prototype check)", async () => {
    class CustomClass {
      constructor(public x: number) {}
    }
    const bad: ToolDef = {
      name: "bad-types",
      description: "mixed types",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({
        d: new Date(),
        m: new Map([["a", 1]]),
        s: new Set([1, 2]),
        c: new CustomClass(1),
      }),
    };
    const exec = createExecutor(createRegistry([bad]));
    const results = await exec.executeAll([
      { id: "c1", name: "bad-types", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    assert.deepEqual(results[0]!.kind === "ok" && results[0]!.payload, [
      { type: "text", text: "[executor: payload not JSON-compatible]" },
    ]);
  });

  it("rejects cyclic references without stack overflow", async () => {
    const cyclic: { self?: unknown; v: number } = { v: 1 };
    cyclic.self = cyclic;
    const bad: ToolDef = {
      name: "bad-cyclic",
      description: "cyclic",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => cyclic,
    };
    const exec = createExecutor(createRegistry([bad]));
    // If recursion guard is missing this will hang or stack-overflow.
    const results = (await Promise.race([
      exec.executeAll([{ id: "c1", name: "bad-cyclic", input: {} }]),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("executor-hang")), 1000)
      ),
    ])) as ReadonlyArray<{
      kind: string;
      payload?: Array<{ type: string; text: string }>;
    }>;
    assert.equal(results[0]!.kind, "ok");
    assert.equal(
      results[0]!.payload?.[0]!.text,
      "[executor: payload not JSON-compatible]"
    );
  });

  it("accepts null / finite numbers / nested plain objects / arrays", async () => {
    const good: ToolDef = {
      name: "good-mix",
      description: "good",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({
        n: null,
        num: 3.14,
        neg: -1,
        bool: false,
        s: "hi",
        arr: [1, 2, [3, null, true, "x"]],
        nested: { a: { b: { c: [] } } },
      }),
    };
    const exec = createExecutor(createRegistry([good]));
    const results = await exec.executeAll([
      { id: "c1", name: "good-mix", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    const text = results[0]!.kind === "ok" && results[0]!.payload[0]!.text;
    assert.equal(typeof text, "string");
    assert.ok(text!.includes('"n":null'));
    assert.ok(text!.includes('"num":3.14'));
    assert.ok(text!.includes('"bool":false'));
    assert.ok(text!.includes('"s":"hi"'));
  });

  // ---- T3 Part B: 20000 cap (ADR-0006 contract X) ----

  it("string payload > 20000 chars: hard-truncated with marker, total length <= 20000", async () => {
    const big = "x".repeat(20001);
    const long: ToolDef = {
      name: "long",
      description: "long string",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => big,
    };
    const exec = createExecutor(createRegistry([long]));
    const results = await exec.executeAll([
      { id: "c1", name: "long", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    const text = results[0]!.kind === "ok" && results[0]!.payload[0]!.text;
    assert.ok(text !== undefined);
    assert.ok(text!.length <= 20000, `text length ${text!.length} > 20000`);
    // Marker required fields per ADR-0006 + T1-1.
    assert.ok(
      /\[executor: 输出超长已截断/.test(text!),
      "marker header present"
    );
    assert.ok(/原长 20001 字符/.test(text!), "original length in marker");
    assert.ok(/保留 \d+ 字符/.test(text!), "kept length in marker");
    assert.ok(
      /如需更多信息，用更精确的输入重新调用/.test(text!),
      "rerun hint present"
    );
    // Marker itself counts toward the 20000 budget.
    assert.ok(text!.endsWith("重新调用]"), "marker ends with closing bracket");
  });

  it("string payload exactly 20000 chars: not truncated", async () => {
    const exact = "y".repeat(20000);
    const atLimit: ToolDef = {
      name: "exact",
      description: "exact",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => exact,
    };
    const exec = createExecutor(createRegistry([atLimit]));
    const results = await exec.executeAll([
      { id: "c1", name: "exact", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    const text = results[0]!.kind === "ok" && results[0]!.payload[0]!.text;
    assert.equal(text, exact);
  });

  it("contract X: handler lies about truncation in payload fields — executor measures actual serialized length", async () => {
    // bash-style structured payload with embedded long string + liar fields.
    // Must force JSON.stringify output to exceed 20000 chars so we can prove
    // executor ignored the liar `truncated:true` and re-measured actual length.
    const longData = "z".repeat(19950);
    const liar: ToolDef = {
      name: "liar",
      description: "liar",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({
        code: 0,
        stdout: longData,
        stderr: "",
        truncated: true, // LIE: tool claims it already truncated
        total: 99999, // LIE: tool claims huge original length
      }),
    };
    const exec = createExecutor(createRegistry([liar]));
    const results = await exec.executeAll([
      { id: "c1", name: "liar", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    const text = results[0]!.kind === "ok" && results[0]!.payload[0]!.text;
    assert.ok(text !== undefined);
    assert.ok(text!.length <= 20000, `length ${text!.length} > 20000`);
    // The serialized length exceeds 20000 (JSON.stringify of 19950 'z' is
    // ~19950 + wrapper) so executor measured actual length and capped,
    // ignoring liar fields.
    assert.ok(/\[executor: 输出超长已截断/.test(text!), "marker present");
    assert.ok(/原长 \d+ 字符/.test(text!), "actual measured length in marker");
  });

  it("object payload > 20000 chars after JSON.stringify: hard-truncated with marker", async () => {
    // Force the object-serialization path to exceed 20000.
    const huge = "a".repeat(19900);
    const obj: ToolDef = {
      name: "huge-obj",
      description: "huge object",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({ code: 0, stdout: huge, stderr: "b".repeat(200) }),
    };
    const exec = createExecutor(createRegistry([obj]));
    const results = await exec.executeAll([
      { id: "c1", name: "huge-obj", input: {} },
    ]);
    assert.equal(results[0]!.kind, "ok");
    const text = results[0]!.kind === "ok" && results[0]!.payload[0]!.text;
    assert.ok(text !== undefined);
    assert.ok(text!.length <= 20000, `length ${text!.length} > 20000`);
    assert.ok(/\[executor: 输出超长已截断/.test(text!), "marker present");
  });
});

describe("failure tool_result structural discriminator (Fix D)", () => {
  it("validation_failed result encodes with [validation_failed] prefix in tool_result text", async () => {
    const strict: ToolDef = {
      name: "strict",
      description: "strict",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "integer" } },
        required: ["n"],
      },
      handler: () => ({ ok: true }),
    };
    const reg = createRegistry([strict]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "a", name: "strict", input: { n: "not-a-number" } },
    ]);
    const blocks = toAnthropicToolResults(results);
    assert.equal(blocks.length, 1);
    const b = blocks[0]! as {
      type: "tool_result";
      is_error: true;
      content: Array<{ type: "text"; text: string }>;
    };
    assert.equal(b.type, "tool_result");
    assert.equal(b.is_error, true);
    assert.equal(b.content[0]!.type, "text");
    assert.ok(
      b.content[0]!.text.startsWith("[validation_failed] "),
      `expected [validation_failed] prefix, got: ${b.content[0]!.text}`
    );
  });

  it("tool_not_found result encodes with [tool_not_found] prefix in tool_result text", async () => {
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "a", name: "missing", input: {} },
    ]);
    const blocks = toAnthropicToolResults(results);
    const b = blocks[0]! as {
      type: "tool_result";
      is_error: true;
      content: Array<{ type: "text"; text: string }>;
    };
    assert.equal(b.is_error, true);
    assert.ok(
      b.content[0]!.text.startsWith("[tool_not_found] "),
      `expected [tool_not_found] prefix, got: ${b.content[0]!.text}`
    );
  });

  it("execution_failed result encodes with [execution_failed] prefix in tool_result text", async () => {
    const reg = createRegistry([boom]);
    const exec = createExecutor(reg);
    const results = await exec.executeAll([
      { id: "a", name: "boom", input: { x: 1 } },
    ]);
    const blocks = toAnthropicToolResults(results);
    const b = blocks[0]! as {
      type: "tool_result";
      is_error: true;
      content: Array<{ type: "text"; text: string }>;
    };
    assert.equal(b.is_error, true);
    assert.ok(
      b.content[0]!.text.startsWith("[execution_failed] "),
      `expected [execution_failed] prefix, got: ${b.content[0]!.text}`
    );
  });
});
