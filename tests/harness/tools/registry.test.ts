/**
 * Registry construction-time validation.
 *
 * Frozen contract: duplicate tool name / bad JSON Schema / validator compile
 * failure -> RegistryConstructionError; after construction the Registry is
 * immutable (Object.freeze); name lookup returns ToolDef / undefined.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { RegistryConstructionError } from "../../../src/harness/errors.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
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
  handler: (i) => i,
};

const sum: ToolDef = {
  name: "sum",
  description: "sum two numbers",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  handler: (input: unknown) => {
    const { a, b } = input as { a: number; b: number };
    return { sum: a + b };
  },
};

describe("createRegistry (S13)", () => {
  it("rejects duplicate tool names with RegistryConstructionError", () => {
    assert.throws(
      () => createRegistry([echo, echo]),
      (e: unknown) =>
        e instanceof RegistryConstructionError &&
        /duplicate/i.test((e as Error).message)
    );
  });

  it("rejects malformed JSON Schema with RegistryConstructionError", () => {
    const bad = {
      name: "bad",
      description: "bad",
      inputSchema: { type: "not-a-real-type" },
      handler: () => ({}),
    };
    assert.throws(
      () => createRegistry([bad]),
      (e: unknown) =>
        e instanceof RegistryConstructionError &&
        (/schema/i.test((e as Error).message) ||
          /validator/i.test((e as Error).message))
    );
  });

  it("rejects schema that ajv cannot compile", () => {
    const bad = {
      name: "bad",
      description: "bad",
      // schema referencing a non-existent keyword (compiler should reject)
      inputSchema: { type: "object", required: 123 },
      handler: () => ({}),
    };
    assert.throws(
      () => createRegistry([bad]),
      (e: unknown) => e instanceof RegistryConstructionError
    );
  });

  it("constructs an immutable registry on success", () => {
    const reg = createRegistry([echo, sum]);
    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    assert.deepEqual(names, ["echo", "sum"]);
    assert.deepEqual(reg.get("echo")?.name, "echo");
    assert.equal(reg.get("missing"), undefined);
    // immutability: list() result is frozen, and reg is frozen
    assert.equal(Object.isFrozen(reg), true);
    assert.equal(Object.isFrozen(reg.list()), true);
  });

  it("rejects tool without a name with RegistryConstructionError", () => {
    const bad = {
      description: "x",
      inputSchema: { type: "object" },
      handler: () => ({}),
    } as unknown as ToolDef;
    assert.throws(
      () => createRegistry([bad]),
      (e: unknown) => e instanceof RegistryConstructionError
    );
  });

  it("registry.getValidator returns compiled validator for registered tool", () => {
    const reg = createRegistry([echo, sum]);
    const v = reg.getValidator("echo");
    assert.equal(typeof v, "function");
    assert.equal(v!({ value: "hi" }), true);
    // Strict-mode failure on bad input.
    assert.equal(v!({ value: 42 }), false);
  });

  it("registry.getValidator returns undefined for unknown tool", () => {
    const reg = createRegistry([echo]);
    assert.equal(reg.getValidator("missing"), undefined);
  });
});
