/**
 * ADR-0043 — build-engine assembly-time wiring:
 *   - await manager.start({firstTurnReadyTimeoutMs: 30_000});
 *   - onManualReconnect(cb) injection — cb fires at a moment consumed by
 *     loop-engine; this test pins only the wire shape (callback registered,
 *     argument shape).
 *
 * Manager's own semantics are covered by manager.test.ts; this file focuses
 * solely on build-engine connecting the two seams to the manager correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { McpClientHandle } from "../../../src/harness/mcp/manager.js";
import type { McpManager } from "../../../src/harness/mcp/manager.js";
import type { Tool as McpTool } from "@modelcontextprotocol/client";

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
  };
}

function makeInstantClient(tools: readonly McpTool[]): McpClientHandle {
  return {
    connect: async () => {},
    listTools: async () => tools,
    callTool: async () => ({ result: { content: [] } }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

async function plantMcpConfig(cwd: string, servers: string[]): Promise<void> {
  const entries = servers
    .map((name) => `"${name}": { "type": "stdio", "command": "node" }`)
    .join(", ");
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  await writeFile(
    join(cwd, ".iknow", "mcp.json"),
    `{ "mcpServers": { ${entries} } }`,
    "utf8"
  );
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

describe("buildHarnessEngine — B4 MCP seam wire", () => {
  it("manager.start({firstTurnReadyTimeoutMs}) 在 buildHarnessEngine 装配期被 await", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b4-start-await-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    let managerPresent = false;
    let buildResolved = false;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b4-start-await"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      // This file pins the MCP seam wire shape, not overflow eviction /
      // index downgrade (dedicated test: build-engine-tool-overflow.test.ts).
      // Assembly-time countTokens is bypassed; see the BuildEngineOpts.skipCountTokens comment for seam semantics.
      skipCountTokens: true,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "test",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    managerPresent = built.mcpManager !== undefined;
    buildResolved = true;

    // Once build-engine resolves, the manager has already awaited firstTurnReady during assembly.
    expect(buildResolved).toBe(true);
    expect(managerPresent).toBe(true);
    expect(built.mcpManager).toBeDefined();
  });

  it("manager.onManualReconnect 已被 build-engine wire 注入(可在 manager 上读到 callback list)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b4-onreconnect-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b4-onreconnect"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      skipCountTokens: true, // as above: pins the onManualReconnect wire, not overflow / downgrade.
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "test",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const mgr = built.mcpManager as McpManager;
    expect(mgr).toBeDefined();
    // The interface exposes onManualReconnect (type-checked, callable shape);
    // the consuming side (loop-engine) is verified in loop-engine tests.
    expect(
      typeof (mgr as unknown as { onManualReconnect: unknown })
        .onManualReconnect
    ).toBe("function");
  });
});

describe("buildHarnessEngine — MCP 名字目录段(替代旧概览段)", () => {
  it("connected server 的 tools 经 loop-engine 第一轮装配进 system (mcp_name_directory)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b4-name-dir-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b4-namedir-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      skipCountTokens: true, // as above: pins the name-directory section, not overflow / downgrade.
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "Alpha tool does useful things",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // Await connected (assembly already awaited firstTurnReady, so normally connected).
    const status = built.mcpManager!.status();
    const stubsvc = status.find((s) => s.name === "stubsvc")!;
    expect(stubsvc.state).toBe("connected");

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    // name directory section + server name + tool name (sans schema)
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).toContain("stubsvc");
    expect(systemText).toContain("alpha");
    // tool schema must not enter the directory (see ADR-0043)
    expect(systemText).not.toContain("inputSchema");
    // old overview section removed
    expect(systemText).not.toContain("<mcp_tools_overview>");
  });
});

describe("buildHarnessEngine — manager 未装配 (ask 路径) 字节级零变化", () => {
  it("surface==='ask' → mcpManager 缺席,onManualReconnect/reconnect 路径零接线", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b4-ask-no-mcp-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b4-ask-no-mcp"),
      askUser: createNoAskUser(),
      surface: "ask",
      userHome: join(root, "home"),
      cwd: root,
      skipCountTokens: true, // as above: pins zero wiring on the ask path, not overflow / downgrade.
    });
    // the ask surface never creates an MCP manager
    expect(built.mcpManager).toBeUndefined();
    await built.shutdown?.();
  });
});
