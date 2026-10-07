// build-engine deps.system wiring test: the MCP name-directory section is
// injected through the single authorized seam (createIknowSystemResolver
// opts.mcp).
//
// Chain: project-level mcp.json → createMcpManager (real) + stub client
// (instant connect, two tools) → registerExternal into the catalog →
// deps.system() assembly-time snapshot (manager.status() +
// reg.catalog.all()) → name-directory rendering.
//
// Contract:
//  - per tool line: `- <name>` or `- <name>: <short desc>` (first line,
//    capped at 120 chars + ellipsis);
//  - missing description → bare tool name rendered (a contract-legal state);
//  - trailing guidance = "Call a listed tool directly to load its schema and use it.";
//  - no mcp config (zero connected servers) → section absent entirely,
//    <available_skills> unaffected.

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { McpClientHandle } from "../../../src/harness/mcp/manager.ts";
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
    // Roots are supplied explicitly to buildHarnessEngine; the env side keeps
    // its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

/** In-memory fake client: connect resolves instantly, listTools returns the injected tools. */
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

/** Plant a project-level mcp.json at <cwd>/.iknow/mcp.json (project tier of the two-level merge). */
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

/** Poll until the named server reaches the target state (background connect is fire-and-forget). */
async function waitForState(
  built: BuiltEngine,
  server: string,
  state: "connected" | "failed",
  deadlineMs = 5_000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const hit = built.mcpManager
      ?.status()
      .find((s) => s.name === server && s.state === state);
    if (hit) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`timeout waiting for '${server}' to become ${state}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

describe("buildHarnessEngine — disclosure-index-align T1 MCP 名字目录段接线", () => {
  it("connected 服务在场 → deps.system() 含名字目录段（服务行 + 工具行 + 末行直呼引导）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-mcp-overview-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-overview-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      // Assertions target the name-directory rendering shape (with
      // descriptions); overflow eviction / index downgrade have dedicated
      // tests (build-engine-tool-overflow.test.ts).
      // Assembly-time countTokens is bypassed; see the BuildEngineOpts.skipCountTokens comment for seam semantics.
      skipCountTokens: true,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "Alpha tool does many useful things",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "beta",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    await waitForState(built, "stubsvc", "connected");

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).toContain("stubsvc");
    // alpha has a description → '- <name>: <short desc>', first line verbatim
    expect(systemText).toContain(
      "- mcp__stubsvc__alpha: Alpha tool does many useful things"
    );
    // beta has no description → bare name (no ": ...")
    expect(systemText).toMatch(/^- mcp__stubsvc__beta$/m);
    expect(systemText).not.toMatch(/^- mcp__stubsvc__beta:/m);
    // schema never enters the name directory (disclosure tiering: schema is
    // loaded on demand via tool_search)
    expect(systemText).not.toContain("inputSchema");
    // trailing guidance is now "Call a listed tool directly..."
    expect(systemText).toContain(
      "Call a listed tool directly to load its schema and use it."
    );
    // old mandatory tool_search guidance removed
    expect(systemText).not.toContain("Use tool_search");
    // old overview section removed
    expect(systemText).not.toContain("<mcp_tools_overview>");
  }, 30_000);

  it("服务名含 '-'（注册侧不 sanitize 服务段）→ 工具仍归属并渲染", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-mcp-dashed-"));
    roots.push(root);
    await plantMcpConfig(root, ["stub-svc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-overview-3"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      skipCountTokens: true, // as above: pins service-segment ownership for '-' in server names, not overflow / downgrade.
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "Dashed server tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    await waitForState(built, "stub-svc", "connected");

    const systemText = await built.deps.system?.();
    expect(systemText).toContain("stub-svc");
    // Registration shape = mcp__<raw server name>__<sanitize(tool name)>;
    // if the projection side sanitized the server segment, this line would
    // silently disappear.
    expect(systemText).toContain("- mcp__stub-svc__alpha: Dashed server tool");
  }, 30_000);

  it("无 mcp 配置（零连接服务）→ 段整体缺席，<available_skills> 不受影响", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-mcp-empty-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-overview-2"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      skipCountTokens: true, // as above: pins section absence with zero connected servers, not overflow / downgrade.
      createMcpClient: () => makeInstantClient([]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<mcp_name_directory>");
    expect(systemText).not.toContain("<mcp_tools_overview>");
    // skills section assembly unaffected (no fixture skills → the explicit
    // empty-list statement is still present)
    expect(systemText).toContain("<available_skills>");
  }, 30_000);
});
