/**
 * The engine owns the session-resident egress agent (plan T4/T5, D1/D9).
 *
 * Pinned invariants:
 *   - the engine's `shutdown` disposes the agent — the agent's own `dispose`
 *     closes the still-live endpoints and releases the credential layer;
 *   - the shutdown exists even when the engine carries no mcp / subagent /
 *     background / auto-memory layer (the ask surface): the presence
 *     condition counts the agent;
 *   - the shutdown is idempotent (a second call neither throws nor re-releases).
 *
 * Technique: module-mock bash.js (the registry's named import lands on the
 * spy; the registry itself stays real) while buildHarnessEngine runs the real
 * assembly — the same pattern as build-engine-bash-wiring.test.ts. The agent
 * itself is the real one; the assertion reads its disposal through its own
 * typed failure (`EgressAgentDisposedError`), never through a spy.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/harness/aci/tools/bash.js", () => ({
  createBashTool: vi.fn(() => ({
    name: "bash",
    description: "stub",
    inputSchema: { type: "object" },
    handler: async () => ({}),
    aci: {
      category: "execute",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "build",
    },
  })),
}));

import { createBashTool } from "../../src/harness/aci/tools/bash.ts";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import {
  EgressAgentDisposedError,
  type EgressAgent,
} from "../../src/harness/sandbox/egress/agent.js";
import type { EgressCallPolicy } from "../../src/harness/sandbox/egress/session.js";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type {
  McpClientHandle,
  McpManagerOptions,
} from "../../src/harness/mcp/manager.ts";

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  } as unknown as IknowEnv;
}

async function plantProjectMcp(root: string): Promise<void> {
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(
    join(root, ".iknow", "mcp.json"),
    JSON.stringify({
      mcpServers: { stub: { type: "stdio", command: "node" } },
    }),
    "utf8"
  );
}

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(createBashTool).mockClear();
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

/** The agent instances the engine handed to its bash factories. */
function engineAgents(): EgressAgent[] {
  return vi
    .mocked(createBashTool)
    .mock.calls.map(
      ([, opts]) =>
        (opts as { egressAgent?: EgressAgent } | undefined)?.egressAgent
    )
    .filter((agent): agent is EgressAgent => agent !== undefined);
}

const CALL_POLICY: EgressCallPolicy = {
  allowedDomains: ["example.com"],
  deniedDomains: [],
  commandLabel: "test:engine-shutdown",
};

async function buildChatEngine(): Promise<BuiltEngine> {
  const productRoot = await mkdtemp(join(tmpdir(), "iknow-egress-agent-prod-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-egress-agent-ws-"));
  roots.push(productRoot, workspaceRoot);
  await plantProjectMcp(productRoot);
  return await buildHarnessEngine({
    env: makeEnv("sk-test-egress-agent"),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(productRoot, "home"),
    cwd: productRoot,
    workspaceRoot,
    productRoot,
    skipCountTokens: true,
    createMcpManager: (managerOpts: McpManagerOptions) =>
      createMcpManager(managerOpts),
    createMcpClient: (): McpClientHandle => ({
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    }),
  });
}

async function buildAskEngine(): Promise<BuiltEngine> {
  const root = await mkdtemp(join(tmpdir(), "iknow-egress-agent-ask-"));
  roots.push(root);
  return await buildHarnessEngine({
    env: makeEnv("sk-test-egress-agent-ask"),
    askUser: createNoAskUser(),
    surface: "ask",
    userHome: join(root, "home"),
    cwd: root,
    workspaceRoot: root,
    productRoot: root,
    skipCountTokens: true,
  });
}

describe("buildHarnessEngine — egress agent 生命周期 (T4/D9)", () => {
  it("engine 的 shutdown 释放 agent,且可重复调用", async () => {
    const built = await buildChatEngine();
    const agents = engineAgents();
    expect(agents.length).toBeGreaterThan(0);
    // One agent per engine assembly: every bash factory of this engine got
    // the SAME instance.
    expect(new Set(agents).size).toBe(1);

    const agent = agents[0]!;
    expect(built.shutdown).toBeDefined();
    await built.shutdown!();

    // The agent is released: a new endpoint fails with the typed error
    // (fail-closed — no endpoint, no direct connection).
    await expect(agent.createCallEndpoint(CALL_POLICY)).rejects.toBeInstanceOf(
      EgressAgentDisposedError
    );

    // Idempotent: a second shutdown neither throws nor re-releases.
    await expect(built.shutdown!()).resolves.toBeUndefined();
    await expect(agent.createCallEndpoint(CALL_POLICY)).rejects.toBeInstanceOf(
      EgressAgentDisposedError
    );
  });

  it("ask 面(无 mcp/background/autoMemory)同样有 shutdown,并释放 agent", async () => {
    const built = await buildAskEngine();
    const agents = engineAgents();
    expect(agents.length).toBeGreaterThan(0);
    const agent = agents[0]!;
    // The presence condition counts the agent: the shutdown exists even
    // though this engine owns no other disposable layer.
    expect(built.shutdown).toBeDefined();
    await built.shutdown!();
    await expect(agent.createCallEndpoint(CALL_POLICY)).rejects.toBeInstanceOf(
      EgressAgentDisposedError
    );
  });
});
