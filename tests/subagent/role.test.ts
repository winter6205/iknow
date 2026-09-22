import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RegistryConstructionError } from "../../src/harness/errors.ts";
import {
  DEFAULT_DISALLOWED_TOOLS,
  applyRoleDenyList,
  buildWorkerToolSurface,
  type SubAgentDefinition,
} from "../../src/harness/subagent/role.ts";

interface NamedTool {
  readonly name: string;
}

/** Sample worker toolset (no spawn_subagent after assembly) for deny-list pruning tests. */
const WORKER_TOOLSET: ReadonlyArray<NamedTool> = Object.freeze([
  { name: "bash" },
  { name: "read_file" },
  { name: "grep" },
  { name: "glob" },
  { name: "edit_file" },
  { name: "write_file" },
  { name: "web_fetch" },
  { name: "web_search" },
  { name: "memory_recall" },
  { name: "memory_save" },
  { name: "tool_search" },
  { name: "lsp_definition" },
  { name: "lsp_references" },
  { name: "lsp_hover" },
  { name: "lsp_document_symbol" },
  { name: "lsp_workspace_symbol" },
  { name: "lsp_go_to_implementation" },
  { name: "lsp_prepare_call_hierarchy" },
  { name: "lsp_incoming_calls" },
  { name: "lsp_outgoing_calls" },
  { name: "lsp_diagnostics" },
  { name: "skill" },
]);

describe("subagent role: SubAgentDefinition 类型形态", () => {
  it("SubAgentDefinition 全字段可选 + 只读", () => {
    const def: SubAgentDefinition = {
      systemPrompt: "be concise",
      disallowedTools: ["edit_file"],
      maxTurns: 5,
      timeoutMs: 30000,
      role: "explore",
      excludeFromHostDrain: true,
    };
    assert.equal(def.systemPrompt, "be concise");
    assert.deepEqual(def.disallowedTools, ["edit_file"]);
    assert.equal(def.maxTurns, 5);
    assert.equal(def.timeoutMs, 30000);
    assert.equal(def.role, "explore");
    assert.equal(def.excludeFromHostDrain, true);
    // readonly enforced by typecheck only; no runtime assert needed
  });

  it("SubAgentDefinition 可为零字段 (worker 全默认)", () => {
    const def: SubAgentDefinition = {};
    assert.deepEqual(def, {});
  });
});

describe("subagent role: DEFAULT_DISALLOWED_TOOLS (SC9 / 假设 7)", () => {
  it("frozen + 长度 1 + 唯一项 = spawn_subagent", () => {
    assert.equal(Object.isFrozen(DEFAULT_DISALLOWED_TOOLS), true);
    assert.equal(DEFAULT_DISALLOWED_TOOLS.length, 1);
    assert.equal(DEFAULT_DISALLOWED_TOOLS[0], "spawn_subagent");
  });
});

describe("subagent role: applyRoleDenyList 严格模式 (SC9 越界 fail-fast)", () => {
  it("undefined / 空 deny → 原样返回", () => {
    const out = applyRoleDenyList(WORKER_TOOLSET, undefined);
    assert.equal(out.length, WORKER_TOOLSET.length);
    assert.equal(Object.isFrozen(out), true);
    assert.deepEqual(
      out.map((t) => t.name),
      WORKER_TOOLSET.map((t) => t.name)
    );

    const empty = applyRoleDenyList(WORKER_TOOLSET, []);
    assert.equal(empty.length, WORKER_TOOLSET.length);
  });

  it("剔除 edit_file / write_file → 其余保留", () => {
    const out = applyRoleDenyList(WORKER_TOOLSET, ["edit_file", "write_file"]);
    const names = out.map((t) => t.name);
    assert.equal(names.includes("edit_file"), false);
    assert.equal(names.includes("write_file"), false);
    assert.equal(out.length, WORKER_TOOLSET.length - 2);
    assert.equal(Object.isFrozen(out), true);
  });

  it("未知工具名 → throw RegistryConstructionError (SC9 越界守门)", () => {
    assert.throws(
      () => applyRoleDenyList(WORKER_TOOLSET, ["foo_tool_not_in_registry"]),
      (err: unknown) => {
        assert.ok(err instanceof RegistryConstructionError);
        assert.match((err as Error).message, /foo_tool_not_in_registry/);
        return true;
      }
    );
  });

  it("allowlist 含 spawn_subagent (子代理 + parent 都启用) → 严格模式正常剔除", () => {
    // parent-agent assembly: spawn_subagent present in available set
    const parentToolset: ReadonlyArray<NamedTool> = Object.freeze([
      ...WORKER_TOOLSET,
      { name: "spawn_subagent" },
    ]);
    const out = applyRoleDenyList(parentToolset, ["spawn_subagent"]);
    assert.equal(out.length, WORKER_TOOLSET.length);
    assert.equal(out.map((t) => t.name).includes("spawn_subagent"), false);
  });

  it("available 为空数组 + deny 非空 → 抛错 (越界 fail-fast 仍生效)", () => {
    assert.throws(
      () => applyRoleDenyList<NamedTool>([], ["bash"]),
      (err: unknown) => err instanceof RegistryConstructionError
    );
  });
});

describe("subagent role: buildWorkerToolSurface 宽容模式 (worker 装配路径)", () => {
  it("默认 deny 含 spawn_subagent (不在 available) → 静默跳过, 不抛", () => {
    // worker toolset lacks spawn_subagent — default deny is redundant protection
    const out = buildWorkerToolSurface(WORKER_TOOLSET);
    assert.equal(out.length, WORKER_TOOLSET.length);
    assert.equal(Object.isFrozen(out), true);
  });

  it("用户 deny edit_file → 同时移除 spawn_subagent (默认, 无变化) + edit_file", () => {
    const out = buildWorkerToolSurface(WORKER_TOOLSET, ["edit_file"]);
    const names = out.map((t) => t.name);
    assert.equal(names.includes("edit_file"), false);
    assert.equal(names.includes("spawn_subagent"), false); // already absent from worker toolset
    assert.equal(out.length, WORKER_TOOLSET.length - 1);
  });

  it("用户 deny 含未知工具名 → 静默跳过 (宽容模式)", () => {
    const out = buildWorkerToolSurface(WORKER_TOOLSET, ["foo_typo"]);
    // no throw: default deny removes spawn_subagent (no-op) + unknown name skipped
    assert.equal(out.length, WORKER_TOOLSET.length);
  });

  it("用户 deny edit_file + foo_typo → 仅 edit_file 真剔除", () => {
    const out = buildWorkerToolSurface(WORKER_TOOLSET, [
      "edit_file",
      "foo_typo",
    ]);
    const names = out.map((t) => t.name);
    assert.equal(names.includes("edit_file"), false);
    assert.equal(out.length, WORKER_TOOLSET.length - 1);
  });

  it("默认 deny + 用户重复声明 spawn_subagent → Set 去重, 无重复越界", () => {
    const out = buildWorkerToolSurface(WORKER_TOOLSET, ["spawn_subagent"]);
    assert.equal(out.length, WORKER_TOOLSET.length); // spawn_subagent already not present
  });

  it("undefined 用户 deny → 仅默认 deny 生效 (无变化)", () => {
    const out = buildWorkerToolSurface(WORKER_TOOLSET, undefined);
    assert.equal(out.length, WORKER_TOOLSET.length);
  });
});
