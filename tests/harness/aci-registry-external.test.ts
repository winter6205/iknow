import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAciRegistry } from "../../src/harness/aci/aci-registry.ts";
import type { AciToolDef } from "../../src/harness/aci/types.ts";
import { RegistryConstructionError } from "../../src/harness/errors.ts";

function makeTool(name: string, lazy = false): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      ...(lazy ? { lazy: true } : {}),
    },
  });
}

describe("ACI registry external registration", () => {
  it("adds an mcp__ tool to catalog, discovery, and visible schemas", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__lookup");

    registry.registerExternal([external]);

    assert.equal(registry.catalog.get(external.name), external);
    assert.deepEqual(
      registry.catalog.all().map((tool) => tool.name),
      ["read_file", external.name]
    );
    assert.equal(registry.discover(external.name), external);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file", external.name]
    );
  });

  it("rejects an external tool outside the mcp__ namespace", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    assert.throws(
      () => registry.registerExternal([makeTool("external_lookup")]),
      RegistryConstructionError
    );
  });

  it("rejects an external tool that duplicates a static tool name", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    assert.throws(
      () => registry.registerExternal([makeTool("read_file")]),
      RegistryConstructionError
    );
  });

  it("keeps inner.list() as the construction-time snapshot", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const before = registry.inner.list();

    registry.registerExternal([makeTool("mcp__server__lookup")]);

    assert.equal(registry.inner.list(), before);
    assert.equal(registry.inner.list().length, 1);
  });

  it("promotes a lazy external tool only after discovery", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__lazy_lookup", true);

    registry.registerExternal([external]);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file"]
    );

    assert.equal(registry.discover(external.name), external);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file", external.name]
    );
  });
});
