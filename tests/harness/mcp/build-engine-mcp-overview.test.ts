// #631 T2 — build-engine deps.system 接线测试：MCP 概览段经唯一授权缝
// (createIknowSystemResolver opts.mcp) 注入。
//
// 链路：project 级 mcp.json → createMcpManager（真）+ stub client（即时连接，
// 两工具）→ registerExternal 入 catalog → deps.system() 装配期快照
// (manager.status() + reg.catalog.all()) → 概览段渲染。
//
// 覆盖：
//  - connected 服务在场 → 段含 service 行 + 工具行 + tool_search 引导；
//  - 无 mcp 配置（空服务列表）→ 段整体缺席，既有 <available_skills> 不受影响。

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
  };
}

/** 即时连接的内存假 client：connect 立即成功，listTools 返回注入的工具。 */
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

/** project 级 mcp.json 植入（<cwd>/.iknow/mcp.json，T3 两级合并的 project 档）。 */
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

/** 轮询等待指定服务进入目标状态（后台连接是 fire-and-forget，SC8）。 */
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

describe("buildHarnessEngine — #631 T2 MCP 概览段接线", () => {
  it("connected 服务在场 → deps.system() 含概览段（服务行 + 工具行 + tool_search 引导）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-mcp-overview-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-overview-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
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
    expect(systemText).toContain("<mcp_tools_overview>");
    expect(systemText).toContain("stubsvc");
    expect(systemText).toContain(
      "mcp__stubsvc__alpha: Alpha tool does many useful things"
    );
    // 缺 description 的工具 → 只渲染名字
    expect(systemText).toContain("mcp__stubsvc__beta");
    expect(systemText).not.toContain("mcp__stubsvc__beta:");
    // 末行引导
    expect(systemText).toContain("tool_search");
  }, 30_000);

  it("无 mcp 配置（零连接服务）→ 段整体缺席，<available_skills> 不受影响", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-mcp-empty-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-overview-2"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () => makeInstantClient([]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<mcp_tools_overview>");
    // skills 段装配不受影响（无 fixture skill → 空清单显式语句仍在）
    expect(systemText).toContain("<available_skills>");
  }, 30_000);
});
