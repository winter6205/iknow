/**
 * Unit tests for the builtin subagent catalog (resolver + entries).
 *
 * Coverage:
 *   - resolveAgentCatalog returns explore + general-purpose entries
 *   - array + every entry frozen
 *   - getAgentEntry: known id returns a frozen entry; unknown id fail-fast with a typed error
 *   - explore entry's disallowedTools merged via buildWorkerToolSurface with the
 *     default deny (spawn_subagent, no-op in practice) + user deny (edit_file /
 *     write_file) → tool surface drops both
 *
 * Design tradeoffs:
 *   - unknown-id fail-fast uses a local typed error (AgentCatalogLookupError),
 *     following the precedent of manager.ts's SubAgentCapacityError /
 *     SubAgentAbortError (manager-local, not in the errors.ts single point);
 *   - entry.disallowedTools is an additive field merged into
 *     buildWorkerToolSurface at worker assembly time — the catalog does not trim
 *     the tool surface itself (it is read-only data, holds no reference to the
 *     available toolset, and cannot trim).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  resolveAgentCatalog,
  getAgentEntry,
  AgentCatalogLookupError,
  type AgentCatalogEntry,
} from "../../src/harness/subagent/catalog.ts";
import { FILE_WRITE_TOOL_NAMES } from "../../src/harness/subagent/catalog.ts";
import { buildWorkerToolSurface } from "../../src/harness/subagent/role.ts";

/** Sample worker toolset (mirror role.test.ts WORKER_TOOLSET) — excludes spawn_subagent. */
const WORKER_TOOLSET: ReadonlyArray<{ readonly name: string }> = Object.freeze([
  { name: "bash" },
  { name: "read_file" },
  { name: "grep" },
  { name: "glob" },
  { name: "edit_file" },
  { name: "write_file" },
  { name: "web_fetch" },
  { name: "web_search" },
]);

describe("subagent catalog: resolveAgentCatalog (B3 resolver seam)", () => {
  it("返回 2 条 entry: explore + general-purpose", () => {
    const catalog = resolveAgentCatalog();
    assert.equal(catalog.length, 2);
    const ids = catalog.map((e) => e.id);
    assert.deepEqual(ids, ["explore", "general-purpose"]);
  });

  it("数组自身 Object.isFrozen", () => {
    const catalog = resolveAgentCatalog();
    assert.equal(Object.isFrozen(catalog), true);
  });

  it("每条 entry 自身 Object.isFrozen", () => {
    const catalog = resolveAgentCatalog();
    for (const entry of catalog) {
      assert.equal(
        Object.isFrozen(entry),
        true,
        `entry ${entry.id} should be frozen`
      );
    }
  });

  it("disallowedTools (若定义) 自身 Object.isFrozen", () => {
    const catalog = resolveAgentCatalog();
    for (const entry of catalog) {
      if (entry.disallowedTools !== undefined) {
        assert.equal(
          Object.isFrozen(entry.disallowedTools),
          true,
          `entry ${entry.id}.disallowedTools should be frozen`
        );
      }
    }
  });

  it("连续两次调用返回同一数组引用 (frozen singleton, 不每次重建)", () => {
    const a = resolveAgentCatalog();
    const b = resolveAgentCatalog();
    assert.equal(a, b);
  });
});

describe("subagent catalog: explore entry (B1 builtin)", () => {
  it("id / description / body / bashMode / disallowedTools 形态齐全", () => {
    const entry = getAgentEntry("explore");
    assert.equal(entry.id, "explore");
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0, "description 非空");
    assert.equal(typeof entry.body, "string");
    assert.ok(entry.body.length > 0, "body (persona 文本) 非空");
    assert.equal(entry.bashMode, "readonly");
    assert.deepEqual([...entry.disallowedTools!], [...FILE_WRITE_TOOL_NAMES]);
  });
});

describe("subagent catalog: general-purpose entry (B1 builtin)", () => {
  it("id / description / body 齐全;bashMode 缺省 (V1 默认 = any);disallowedTools 缺省", () => {
    const entry = getAgentEntry("general-purpose");
    assert.equal(entry.id, "general-purpose");
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0);
    assert.equal(typeof entry.body, "string");
    assert.ok(entry.body.length > 0);
    // bashMode absent → V1-equivalent "any" (per the assembly-chain fallback decision)
    assert.equal(
      entry.bashMode,
      undefined,
      "general-purpose bashMode 缺省, 由 T6 装配链路默认 any"
    );
    // disallowedTools absent → no extra user deny; the default deny of
    // spawn_subagent is auto-added by buildWorkerToolSurface (silent, since the
    // worker toolset never contains it)
    assert.equal(entry.disallowedTools, undefined);
  });
});

describe("subagent catalog: getAgentEntry 已知 / 未知 id (B3 fail-fast)", () => {
  it("已知 id 'explore' 返回冻结 entry", () => {
    const entry = getAgentEntry("explore");
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.id, "explore");
  });

  it("已知 id 'general-purpose' 返回冻结 entry", () => {
    const entry = getAgentEntry("general-purpose");
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.id, "general-purpose");
  });

  it("未知 id → 抛 AgentCatalogLookupError (typed, fail-fast)", () => {
    assert.throws(
      () => getAgentEntry("not_a_real_agent"),
      (err: unknown) => {
        assert.ok(err instanceof AgentCatalogLookupError);
        assert.match((err as Error).message, /not_a_real_agent/);
        return true;
      }
    );
  });

  it("空字符串 id → 抛 typed error (fail-fast 守门)", () => {
    assert.throws(
      () => getAgentEntry(""),
      (err: unknown) => err instanceof AgentCatalogLookupError
    );
  });
});

describe("subagent catalog: entry.disallowedTools 合并 buildWorkerToolSurface (SC9 deny-list)", () => {
  it("explore disallowedTools (edit_file + write_file) 合并默认 deny → 工具面同步剔除", () => {
    const explore = getAgentEntry("explore");
    // merge path: disallowedTools from the catalog goes through
    // buildWorkerToolSurface, merged with the default deny (spawn_subagent, not
    // in the worker toolset, silent) + entry deny
    const surface = buildWorkerToolSurface(
      WORKER_TOOLSET,
      explore.disallowedTools
    );
    const names = surface.map((t) => t.name);
    assert.equal(names.includes("edit_file"), false);
    assert.equal(names.includes("write_file"), false);
    // default deny of spawn_subagent is absent from the worker toolset → silent, count drops by 2
    assert.equal(surface.length, WORKER_TOOLSET.length - 2);
    // other tools retained
    assert.equal(names.includes("read_file"), true);
    assert.equal(names.includes("bash"), true);
    assert.equal(Object.isFrozen(surface), true);
  });

  it("general-purpose 无 disallowedTools → buildWorkerToolSurface 行为不变", () => {
    const gp = getAgentEntry("general-purpose");
    const surface = buildWorkerToolSurface(WORKER_TOOLSET, gp.disallowedTools);
    assert.equal(surface.length, WORKER_TOOLSET.length);
  });
});

describe("subagent catalog: AgentCatalogEntry 类型形态", () => {
  it("类型级别字段: id / description / body 必填;bashMode / disallowedTools 可选", () => {
    // typecheck-only verification: missing required fields must fail at compile time (no runtime assert needed)
    const full: AgentCatalogEntry = {
      id: "x",
      description: "d",
      body: "b",
      bashMode: "any",
      disallowedTools: ["foo"],
    };
    const minimal: AgentCatalogEntry = {
      id: "y",
      description: "d",
      body: "b",
    };
    assert.equal(full.id, "x");
    assert.equal(minimal.id, "y");
    // readonly fields verified via typecheck (no runtime check needed)
  });
});
