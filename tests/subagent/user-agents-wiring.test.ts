/**
 * Wiring tests: user agents catalog -> spawn_subagent / capability / worker persona.
 *
 * Covers:
 *   - merged resolver injected into the spawn tool -> enum + prose list include user role ids
 *   - handler with subagent_type=<user role> -> def.role passthrough + frontmatter
 *     disallowedTools unioned with the parent deny list
 *   - resolveSubagentCapabilities consumes user-role frontmatter (bashMode/deny)
 *   - createWorkerDeps(userHome=fixture) -> deps.system() injects the user role body
 *   - empty user dir through merged resolver -> both builtins still present (hermetic)
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createMergedCatalogResolver } from "../../src/harness/subagent/user-catalog.ts";
import { resetUserAgentsCache } from "../../src/harness/subagent/user-catalog.ts";
import { resolveSubagentCapabilities } from "../../src/harness/subagent/capability.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { vi } from "vitest";

let agentsDir: string;
beforeEach(() => {
  agentsDir = mkdtempSync(path.join(tmpdir(), "iknow-agents-wiring-"));
  resetUserAgentsCache();
});
afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  resetUserAgentsCache();
});

/** User-role fixture: readonly bash + two write tools denied. */
function writeReviewerRole(): void {
  mkdirSync(path.join(agentsDir, "reviewer"));
  writeFileSync(
    path.join(agentsDir, "reviewer", "AGENTS.md"),
    "---\ndescription: Review-only role.\nbashMode: readonly\ndisallowedTools: edit_file, write_file\n---\n\nYou are a USER REVIEWER persona."
  );
}

function makeFakeManager() {
  const spawn = vi.fn(
    (_def: SubAgentDefinition): { readonly taskId: string } => ({
      taskId: "fixed-task-id-1",
    })
  );
  const manager: SubAgentManager = {
    spawn,
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor: async () => ({
      status: "ok" as const,
      summary: "from-fake",
      result: "",
    }),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    listSubagents: () => [],
    // ADR-0096: the spawn_subagent description getter reads capacity.
    // Degraded path: this fake wires no holder -> falls back to manager.getCapacity().
    getCapacity: () => 15,
  };
  return { manager, spawn };
}

describe("spawn_subagent × 用户角色目录", () => {
  it("enum + prose list 含用户角色 id", () => {
    writeReviewerRole();
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: createMergedCatalogResolver({
        agentsDir: agentsDir,
        warn: () => {},
      }),
    });
    const schema = tool.inputSchema as {
      properties: { subagent_type: { enum: string[] } };
    };
    assert.ok(schema.properties.subagent_type.enum.includes("reviewer"));
    assert.ok(tool.description.includes("reviewer: Review-only role."));
  });

  it("handler subagent_type=reviewer → def.role + deny union (parent ADD)", async () => {
    writeReviewerRole();
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: createMergedCatalogResolver({
        agentsDir: agentsDir,
        warn: () => {},
      }),
    });
    await tool.handler({
      title: "review pass",
      task: "review the diff",
      subagent_type: "reviewer",
      disallowedTools: ["web_search"],
    });
    const def = spawn.mock.calls[0]![0] as SubAgentDefinition;
    assert.equal(def.role, "reviewer");
    assert.deepEqual(def.disallowedTools, [
      "web_search",
      "edit_file",
      "write_file",
    ]);
  });

  it("空用户目录经 merged resolver 注入 → enum 仍含 builtin 两条 (hermetic)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: createMergedCatalogResolver({
        agentsDir: path.join(agentsDir, "not-there"),
        warn: () => {},
      }),
    });
    const schema = tool.inputSchema as {
      properties: { subagent_type: { enum: string[] } };
    };
    assert.ok(schema.properties.subagent_type.enum.includes("explore"));
    assert.ok(schema.properties.subagent_type.enum.includes("general-purpose"));
  });
});

describe("capability × 用户角色", () => {
  it("frontmatter bashMode/deny 进 capability 解析", () => {
    writeReviewerRole();
    const caps = resolveSubagentCapabilities({
      role: "reviewer",
      catalog: createMergedCatalogResolver({
        agentsDir: agentsDir,
        warn: () => {},
      }),
    });
    assert.equal(caps.bashMode, "readonly");
    assert.deepEqual(caps.disallowedTools, ["edit_file", "write_file"]);
    assert.equal(caps.catalogError, undefined);
  });
});

// ─── worker persona injection (userHome fixture -> ~/.iknow/agents) ──────────

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

function hermeticOpts(
  extra?: Record<string, unknown>
): Parameters<typeof createWorkerDeps>[0] {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  } as Parameters<typeof createWorkerDeps>[0];
}

describe("createWorkerDeps persona 注入 × 用户角色目录", () => {
  it("role=用户角色 → deps.system() 含用户 body", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "iknow-agents-home-"));
    try {
      mkdirSync(path.join(home, ".iknow", "agents", "reviewer"), {
        recursive: true,
      });
      writeFileSync(
        path.join(home, ".iknow", "agents", "reviewer", "AGENTS.md"),
        "You are a USER REVIEWER persona."
      );
      resetUserAgentsCache();
      const deps = await createWorkerDeps(
        hermeticOpts({ role: "reviewer", userHome: home })
      );
      const out = (await deps.system?.()) ?? "";
      assert.ok(out.includes("You are a USER REVIEWER persona."));
    } finally {
      rmSync(home, { recursive: true, force: true });
      resetUserAgentsCache();
    }
  });

  it("用户角色 bashMode=readonly → deps.system() 含 readonly constraints 段", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "iknow-agents-home-"));
    try {
      mkdirSync(path.join(home, ".iknow", "agents", "guard"), {
        recursive: true,
      });
      writeFileSync(
        path.join(home, ".iknow", "agents", "guard", "AGENTS.md"),
        "---\nbashMode: readonly\n---\nGuard body."
      );
      resetUserAgentsCache();
      const deps = await createWorkerDeps(
        hermeticOpts({ role: "guard", userHome: home })
      );
      const out = (await deps.system?.()) ?? "";
      assert.ok(out.includes("Guard body."));
      assert.match(out, /Tool constraints for this run/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      resetUserAgentsCache();
    }
  });
});
