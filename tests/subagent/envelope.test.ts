import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  parseParentEnvelope,
  parseWorkerEnvelope,
  truncateEnvelopeResult,
} from "../../src/harness/subagent/envelope.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";

describe("subagent envelope schema (SC13 / D1)", () => {
  it("parses a valid worker request (parent → child)", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "investigate X",
        systemPrompt: "be concise",
        disallowedTools: ["edit_file"],
        model: "opus",
        maxTurns: 5,
        timeoutMs: 30000,
        sandboxRoot: "/tmp/sb",
        env: { FOO: "bar" },
      })
    );
    assert.equal(env.task, "investigate X");
    assert.equal(env.systemPrompt, "be concise");
    assert.deepEqual(env.disallowedTools, ["edit_file"]);
    assert.equal(env.model, "opus");
    assert.equal(env.maxTurns, 5);
    assert.equal(env.timeoutMs, 30000);
    assert.equal(env.sandboxRoot, "/tmp/sb");
    assert.deepEqual(env.env, { FOO: "bar" });
  });

  it("parses a minimal worker request (only required fields)", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "minimal", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(env.task, "minimal");
    assert.equal(env.sandboxRoot, "/tmp/sb");
    assert.equal(env.maxTurns, undefined);
  });

  it("throws ProtocolError when a required worker field is missing (task)", () => {
    assert.throws(
      () => parseWorkerEnvelope(JSON.stringify({ sandboxRoot: "/tmp/sb" })),
      ProtocolError
    );
  });

  it("throws ProtocolError when a required worker field is missing (sandboxRoot)", () => {
    assert.throws(
      () => parseWorkerEnvelope(JSON.stringify({ task: "no root" })),
      ProtocolError
    );
  });

  it("throws ProtocolError on wrong field type (task: 123)", () => {
    assert.throws(
      () =>
        parseWorkerEnvelope(
          JSON.stringify({ task: 123, sandboxRoot: "/tmp/sb" })
        ),
      ProtocolError
    );
  });

  it("throws ProtocolError on non-object input (bare string)", () => {
    assert.throws(() => parseWorkerEnvelope('"just a string"'), ProtocolError);
  });

  it("throws ProtocolError on non-object input (array)", () => {
    assert.throws(() => parseWorkerEnvelope("[1, 2, 3]"), ProtocolError);
  });

  it("throws ProtocolError on invalid JSON", () => {
    assert.throws(() => parseWorkerEnvelope("{not json"), ProtocolError);
  });

  it("parses a valid line with a trailing newline", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "trailing", sandboxRoot: "/tmp/sb" }) + "\n"
    );
    assert.equal(env.task, "trailing");
  });

  it("multi-newline input parses by the first standalone JSON", () => {
    const first = JSON.stringify({ task: "first", sandboxRoot: "/tmp/sb" });
    const second = JSON.stringify({ task: "second", sandboxRoot: "/tmp/sb" });
    const env = parseWorkerEnvelope(`${first}\n${second}`);
    assert.equal(env.task, "first");
  });

  it("parses a valid parent (child → parent) ok envelope", () => {
    const env = parseParentEnvelope(
      JSON.stringify({ status: "ok", summary: "s", result: "r" })
    );
    assert.equal(env.status, "ok");
    assert.equal(env.summary, "s");
    assert.equal(env.result, "r");
  });

  it("parses a failed parent envelope with reason", () => {
    const env = parseParentEnvelope(
      JSON.stringify({
        status: "failed",
        reason: "crashed",
        summary: "s",
        result: "r",
      })
    );
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
  });

  it("rejects an invalid status enum value", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({ status: "running", summary: "s", result: "r" })
        ),
      ProtocolError
    );
  });

  it("rejects an invalid reason enum value", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "failed",
            reason: "exploded",
            summary: "s",
            result: "r",
          })
        ),
      ProtocolError
    );
  });

  it("throws ProtocolError when parent status is missing", () => {
    assert.throws(
      () => parseParentEnvelope(JSON.stringify({ summary: "s", result: "r" })),
      ProtocolError
    );
  });

  it("rejects additional unknown properties", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify({
            status: "ok",
            summary: "s",
            result: "r",
            sneaky: true,
          })
        ),
      ProtocolError
    );
  });

  it("rejects a bare JSON array for the parent envelope", () => {
    assert.throws(
      () =>
        parseParentEnvelope(
          JSON.stringify([{ status: "ok", summary: "s", result: "r" }])
        ),
      ProtocolError
    );
  });
});

describe("subagent envelope truncation (SC10)", () => {
  it("returns the envelope unchanged when result is within 20000 chars", () => {
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: "s",
      result: "short result",
    };
    const out = truncateEnvelopeResult(env);
    assert.equal(out, env);
    assert.equal(out.result, "short result");
    assert.equal(out.truncated, undefined);
    assert.equal(out.totalLength, undefined);
  });

  it("truncates result over 20000 chars with synthesized marker + meta fields", () => {
    const long = "x".repeat(25000);
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: "s",
      result: long,
    };
    const out = truncateEnvelopeResult(env);
    assert.equal(out.truncated, true);
    assert.equal(out.totalLength, 25000);
    assert.match(
      out.result,
      /^\[\.\.\.truncated to 20000 chars; total 25000\]$/
    );
    assert.equal(out.status, "ok");
    assert.equal(out.summary, "s");
  });

  it("keeps exactly-20000 result untruncated", () => {
    const env: SubAgentEnvelope = {
      status: "ok",
      summary: "s",
      result: "y".repeat(20000),
    };
    const out = truncateEnvelopeResult(env);
    assert.equal(out, env);
    assert.equal(out.truncated, undefined);
  });
});

describe("subagent envelope types (SC2 field shape)", () => {
  it("WorkerEnvelope exposes optional camelCase fields", () => {
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "/tmp/sb",
      systemPrompt: "p",
      disallowedTools: ["a"],
      model: "m",
      maxTurns: 3,
      timeoutMs: 1000,
      env: { K: "v" },
    };
    assert.equal(env.task, "t");
    assert.equal(env.sandboxRoot, "/tmp/sb");
  });

  it("SubAgentEnvelope exposes reason enum + truncation meta fields", () => {
    const env: SubAgentEnvelope = {
      status: "failed",
      summary: "s",
      result: "r",
      reason: "maxTurnsExceeded",
      truncated: true,
      totalLength: 25000,
    };
    assert.equal(env.reason, "maxTurnsExceeded");
    assert.equal(env.truncated, true);
  });
});
