/**
 * T3 Executor:串行 / 无短路 / 无自动重试。
 *
 * 015 强制:按 assistant content blocks 中 tool calls 出现顺序串行执行;
 * 某个调用失败不短路该回合剩余调用;失败立即回填,不自动重试;严格校验
 * 失败时不调用工具,只形成可修正 ToolExecutionResult。
 */

import { describe, it } from "node:test";
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
      true,
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
      ["a", "b", "c"],
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
      `expected [validation_failed] prefix, got: ${b.content[0]!.text}`,
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
      `expected [tool_not_found] prefix, got: ${b.content[0]!.text}`,
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
      `expected [execution_failed] prefix, got: ${b.content[0]!.text}`,
    );
  });
});