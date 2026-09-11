/**
 * Offline lock for the worktree ACI rename golden set.
 *
 * Invariant (specs/create-worktree-tools.md D1 / D2 / D4, SC3–SC4 first
 * half): the registered worktree family is the `-worktree` names, operator
 * create/list inputs have decidable first tools, and every worktree
 * description states capability without policy. First-tool hard gate is the
 * real-LLM sibling under archive/tests-real-llm (SC6); this file stays
 * offline so default `npm test` does not call a model.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createCreateWorktreeTool } from "../../../../src/harness/aci/tools/create-worktree.ts";
import { createEnterWorktreeTool } from "../../../../src/harness/aci/tools/enter-worktree.ts";
import { createExitWorktreeTool } from "../../../../src/harness/aci/tools/exit-worktree.ts";
import { createListWorktreesTool } from "../../../../src/harness/aci/tools/list-worktrees.ts";
import { createRemoveWorktreeTool } from "../../../../src/harness/aci/tools/remove-worktree.ts";
import { CREATE_WORKTREE_TOOL_HINT } from "../../../../src/harness/isolation/worktree-gate.ts";
import { ACI_TOOLSET_NAMES } from "../../../../src/harness/aci/tools/registry.ts";
import {
  LEGACY_WORKTREE_TOOL_NAMES,
  WORKTREE_TOOL_FIXTURES,
  WORKTREE_TOOL_NAMES,
  decidingToolIndex,
  worktreeFixtureById,
  type WorktreeToolFixture,
} from "./worktree-tool-names.fixtures.ts";

const factories = {
  "create-worktree": () => createCreateWorktreeTool({} as never),
  "enter-worktree": () => createEnterWorktreeTool({} as never),
  "exit-worktree": () => createExitWorktreeTool({} as never),
  "list-worktrees": () => createListWorktreesTool({} as never),
  "remove-worktree": () => createRemoveWorktreeTool({} as never),
} as const;

describe("worktree tool golden set (fixtures)", () => {
  it("contains one create fixture and one list fixture", () => {
    assert.equal(WORKTREE_TOOL_FIXTURES.length, 2);
    assert.deepEqual(
      WORKTREE_TOOL_FIXTURES.map((f) => f.id),
      ["sc3-create", "sc4-list"]
    );
  });

  const sc3 = worktreeFixtureById("sc3-create");
  it(sc3.title, () => {
    assertFixtureRunnable(sc3);
    assert.equal(sc3.expectedFirstTool, "create-worktree");
    assert.match(sc3.userPrompt, /工作树/);
  });

  const sc4 = worktreeFixtureById("sc4-list");
  it(sc4.title, () => {
    assertFixtureRunnable(sc4);
    assert.equal(sc4.expectedFirstTool, "list-worktrees");
    assert.match(sc4.userPrompt, /哪些|列出/);
    // SC4 是 list 夹具：输入不得把 create 当作期望首工具。
    assert.notEqual(sc4.expectedFirstTool, "create-worktree");
  });
});

describe("decidingToolIndex (trajectory verdict)", () => {
  it("skips tolerated prelude tools and lands on the deciding tool", () => {
    const sc4 = worktreeFixtureById("sc4-list");
    assert.equal(
      decidingToolIndex([{ name: "grep" }, { name: "list-worktrees" }], sc4),
      1
    );
  });

  it("a bash call before the expected tool is the deciding tool (fixture fails)", () => {
    const sc4 = worktreeFixtureById("sc4-list");
    assert.equal(
      decidingToolIndex([{ name: "bash" }, { name: "list-worktrees" }], sc4),
      0
    );
  });

  it("all-prelude trace has no deciding tool", () => {
    const sc4 = worktreeFixtureById("sc4-list");
    assert.equal(
      decidingToolIndex([{ name: "grep" }, { name: "glob" }], sc4),
      -1
    );
  });
});

describe("worktree tool registered names (SC1)", () => {
  it("every worktree tool registers under its new name", () => {
    for (const name of WORKTREE_TOOL_NAMES) {
      assert.equal(factories[name]().name, name);
    }
  });

  it("no registered worktree tool carries a legacy name", () => {
    const registered = new Set(
      WORKTREE_TOOL_NAMES.map((name) => factories[name]().name)
    );
    for (const legacy of LEGACY_WORKTREE_TOOL_NAMES) {
      assert.equal(registered.has(legacy as never), false);
    }
  });

  it("ACI_TOOLSET_NAMES lists the five new names and none of the old", () => {
    const toolset: ReadonlyArray<string> = ACI_TOOLSET_NAMES;
    for (const name of WORKTREE_TOOL_NAMES) {
      assert.equal(
        toolset.includes(name),
        true,
        `${name} missing from toolset`
      );
    }
    for (const legacy of LEGACY_WORKTREE_TOOL_NAMES) {
      assert.equal(
        toolset.includes(legacy),
        false,
        `${legacy} still in toolset`
      );
    }
  });

  it("gate hint names the registered create tool (exact literal, SC5)", () => {
    // 精确字面：前缀匹配放过 `create-worktree-something` 一类漂移，
    // 而 SC5 要求回执点名的就是注册名本身。
    assert.equal(CREATE_WORKTREE_TOOL_HINT, "create-worktree ACI tool");
  });
});

describe("worktree descriptions state capability, not policy (SC2)", () => {
  it("no description mentions [worktree_isolation] or names list as a create prerequisite", () => {
    for (const name of WORKTREE_TOOL_NAMES) {
      const desc = factories[name]().description;
      assert.equal(desc.includes("worktree_isolation"), false, name);
      assert.equal(/\blist\b[^.]*\bfirst\b/i.test(desc), false, name);
      assert.equal(/先\s*list/.test(desc), false, name);
    }
  });

  it("no description names a legacy tool", () => {
    for (const name of WORKTREE_TOOL_NAMES) {
      const desc = factories[name]().description;
      for (const legacy of LEGACY_WORKTREE_TOOL_NAMES) {
        assert.equal(desc.includes(legacy), false, `${name} names ${legacy}`);
      }
    }
  });
});

function assertFixtureRunnable(fixture: WorktreeToolFixture): void {
  assert.ok(fixture.title.length > 0);
  assert.ok(fixture.userPrompt.trim().length > 0);
  assert.ok(fixture.spec === "SC3" || fixture.spec === "SC4");
}
