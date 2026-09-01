/**
 * #556 T1 — builtin subagent catalog (resolver + entries) 单测。
 *
 * 覆盖 plan T1 acceptance:
 *   - resolveAgentCatalog 返回 explore + general-purpose 两条 entry
 *   - 数组 + 每条 entry 冻结
 *   - getAgentEntry 已知 id 返回冻结 entry;未知 id fail-fast 抛 typed error
 *   - explore entry 的 disallowedTools 经 buildWorkerToolSurface 合并默认 deny
 *     (spawn_subagent, 实际无变化) + 用户 deny (edit_file / write_file) →
 *     tool surface 同时剔除两者
 *
 * 设计取舍 (T2 / T6 后续用):
 *   - 未知 id fail-fast 用本地 typed error (AgentCatalogLookupError),
 *     precedent 仿 manager.ts 的 SubAgentCapacityError / SubAgentAbortError
 *     (manager-local, 不进 errors.ts 单点);
 *   - entry.disallowedTools 是 additive 字段, 由 worker 装配期合并进
 *     buildWorkerToolSurface —— 不在 catalog 内部直接裁剪工具面 (catalog
 *     是只读数据, 不持有 available toolset 引用, 也无法做裁剪)。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  resolveAgentCatalog,
  getAgentEntry,
  AgentCatalogLookupError,
  type AgentCatalogEntry,
} from "../../src/harness/subagent/catalog.ts";
import { FILE_WRITE_TOOL_NAMES } from "../../src/harness/aci/tools/symbol-mutate.ts";
import { buildWorkerToolSurface } from "../../src/harness/subagent/role.ts";

/** Sample worker toolset (mirror role.test.ts WORKER_TOOLSET) — 不含 spawn_subagent。 */
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
    // bashMode absent → V1 等价 "any" (per T6 fallback 决议)
    assert.equal(
      entry.bashMode,
      undefined,
      "general-purpose bashMode 缺省, 由 T6 装配链路默认 any"
    );
    // disallowedTools absent → 用户不额外 deny, 默认 deny spawn_subagent
    // 由 buildWorkerToolSurface 自动叠加 (worker toolset 本来就不含, 静默)
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
    // merge 路径: catalog 拿到的 disallowedTools 经 buildWorkerToolSurface 合并
    // 默认 deny (spawn_subagent, worker toolset 不含, 静默) + entry deny
    const surface = buildWorkerToolSurface(
      WORKER_TOOLSET,
      explore.disallowedTools
    );
    const names = surface.map((t) => t.name);
    assert.equal(names.includes("edit_file"), false);
    assert.equal(names.includes("write_file"), false);
    // 默认 deny spawn_subagent 在 worker toolset 不含 → 静默, 数量变化 = -2
    assert.equal(surface.length, WORKER_TOOLSET.length - 2);
    // 其它工具保留
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
    // typecheck-only 验证: 必填字段缺失编译期应当失败 (运行时不需要再 assert)
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
    // readonly 字段 typecheck 验证 (运行时不需要)
  });
});
