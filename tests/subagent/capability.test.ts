import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  AgentCatalogLookupError,
  type AgentCatalogResolver,
} from "../../src/harness/subagent/catalog.ts";
import {
  assessSubagentIsolation,
  mergeDisallowedTools,
  resolveBashMode,
  resolveSubagentCapabilities,
} from "../../src/harness/subagent/capability.ts";

describe("subagent capability derivation", () => {
  it("merges parent and catalog deny lists once, preserving first-seen order", () => {
    const merged = mergeDisallowedTools(
      ["bash", "edit_file", "bash"],
      ["write_file", "edit_file"]
    );

    assert.deepEqual([...merged!], ["bash", "edit_file", "write_file"]);
    assert.equal(Object.isFrozen(merged), true);
  });

  it("derives the same capability result for dispatch and worker inputs", () => {
    const dispatched = resolveSubagentCapabilities({
      role: "explore",
      parentDisallowedTools: ["bash"],
    });
    const worker = resolveSubagentCapabilities({
      role: "explore",
      parentDisallowedTools: dispatched.disallowedTools,
    });

    assert.deepEqual(worker, dispatched);
  });

  it("uses catalog bashMode and keeps parent deny separate from bashMode", () => {
    const explore = resolveSubagentCapabilities({ role: "explore" });
    const generalPurpose = resolveSubagentCapabilities({
      role: "general-purpose",
      parentDisallowedTools: ["bash"],
    });

    assert.equal(explore.bashMode, "readonly");
    assert.equal(generalPurpose.bashMode, "any");
    assert.deepEqual([...generalPurpose.disallowedTools!], ["bash"]);
  });
});

describe("subagent isolation capability", () => {
  it("allows an explore surface with only read tools and readonly bash", () => {
    const decision = assessSubagentIsolation({
      role: "explore",
      availableTools: ["bash", "read_file", "edit_file", "write_file"],
    });

    assert.deepEqual(decision, {
      conclusion: "readonly",
      reason: "write_tools_denied_bash_readonly",
      effectiveTools: ["bash", "read_file"],
    });
  });

  it("rejects any-mode bash even when edit and write tools are denied", () => {
    const decision = assessSubagentIsolation({
      role: "general-purpose",
      availableTools: ["bash", "read_file", "edit_file", "write_file"],
      disallowedTools: ["edit_file", "write_file"],
    });

    assert.equal(decision.conclusion, "write");
    assert.equal(decision.reason, "bash_mode_not_readonly");
    assert.deepEqual(decision.effectiveTools, ["bash", "read_file"]);
  });

  it("allows a general-purpose role when all write-capable tools are denied", () => {
    const decision = assessSubagentIsolation({
      role: "general-purpose",
      availableTools: ["bash", "read_file", "edit_file", "write_file"],
      disallowedTools: ["edit_file", "write_file", "bash"],
    });

    assert.deepEqual(decision, {
      conclusion: "readonly",
      reason: "write_tools_and_bash_denied",
      effectiveTools: ["read_file"],
    });
  });

  it("fails closed for an unknown role even with an empty effective surface", () => {
    const decision = assessSubagentIsolation({
      role: "not-a-real-role",
      availableTools: [],
    });

    assert.equal(decision.conclusion, "write");
    assert.equal(decision.reason, "unknown_role_fail_closed");
    assert.deepEqual(decision.effectiveTools, []);
    assert.ok(decision.catalogError instanceof AgentCatalogLookupError);
  });
});

describe("subagent capability boundaries", () => {
  it("handles empty deny lists and empty tool surfaces", () => {
    const merged = mergeDisallowedTools([], undefined);
    const decision = assessSubagentIsolation({
      role: "general-purpose",
      availableTools: [],
      disallowedTools: [],
    });

    assert.deepEqual([...merged!], []);
    assert.deepEqual(decision.effectiveTools, []);
    assert.equal(decision.conclusion, "readonly");
  });

  it("deduplicates a long deny list without changing the effective result", () => {
    const repeated = Array.from({ length: 10_000 }, (_, index) =>
      index % 2 === 0 ? "edit_file" : "write_file"
    );
    const merged = mergeDisallowedTools(repeated, [
      "edit_file",
      "bash",
      "bash",
    ]);

    assert.deepEqual([...merged!], ["edit_file", "write_file", "bash"]);
  });

  it("is stateless and idempotent under concurrent calls", async () => {
    const input = {
      role: "explore",
      availableTools: ["bash", "read_file", "edit_file", "write_file"],
    } as const;
    const decisions = await Promise.all(
      Array.from({ length: 32 }, () => assessSubagentIsolation(input))
    );

    for (const decision of decisions) {
      assert.deepEqual(decision, decisions[0]);
    }
  });

  it("retains the typed catalog lookup error as a fail-closed diagnostic", () => {
    const catalog: AgentCatalogResolver = {
      list: () => [],
      get: () => {
        throw new AgentCatalogLookupError("broken-catalog");
      },
    };

    const resolved = resolveSubagentCapabilities({
      role: "broken-catalog",
      catalog,
    });

    assert.equal(resolved.bashMode, "any");
    assert.ok(resolved.catalogError instanceof AgentCatalogLookupError);
    assert.equal(resolveBashMode("broken-catalog", catalog), "any");
  });
});
