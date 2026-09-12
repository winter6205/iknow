// disclosure-index-align T1 — build-engine deps.system 接线测试：MCP 名字目录段经
// 唯一授权缝（createIknowSystemResolver opts.mcp）注入。
//
// 链路：project 级 mcp.json → createMcpManager（真）+ stub client（即时连接，
// 两工具）→ registerExternal 入 catalog → deps.system() 装配期快照
// (manager.status() + reg.catalog.all()) → 名字目录段渲染。
//
// T1 contract（specs/disclosure-index-align.md Does #1 / SC1 + SC2）：
//  - 每工具行：`- <name>` 或 `- <name>: <short desc>`（首行 + 限 120 字 + …）；
//  - 描述缺席 → 只渲染工具名（契约允许态）；
//  - 末行引导 = "Call a listed tool directly to load its schema and use it."；
//  - 无 mcp 配置（零连接服务）→ 段整体缺席，<available_skills> 不受影响。

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
      // 断言看的是名字目录段的渲染形态(含描述),不验溢出退场 / 索引降档
      // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
      // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
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
    // alpha 有描述 → '- <name>: <short desc>'，首行原样
    expect(systemText).toContain(
      "- mcp__stubsvc__alpha: Alpha tool does many useful things"
    );
    // beta 无描述 → 裸名（无 ": ..."）
    expect(systemText).toMatch(/^- mcp__stubsvc__beta$/m);
    expect(systemText).not.toMatch(/^- mcp__stubsvc__beta:/m);
    // schema 不进名字目录（披露分层：schema 须 tool_search 按需）
    expect(systemText).not.toContain("inputSchema");
    // 末行引导改为 "Call a listed tool directly..."
    expect(systemText).toContain(
      "Call a listed tool directly to load its schema and use it."
    );
    // 旧 tool_search 强制引导已撤
    expect(systemText).not.toContain("Use tool_search");
    // 旧概览段已撤除
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
      skipCountTokens: true, // 同上:验服务名 '-' 的服务段归属,不验溢出 / 索引降档。
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
    // 注册形态 = mcp__<原始服务名>__<sanitize(工具名)>；若投影侧
    // sanitize 服务段，此行会静默缺席。
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
      skipCountTokens: true, // 同上:验零连接服务时段缺席,不验溢出 / 索引降档。
      createMcpClient: () => makeInstantClient([]),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<mcp_name_directory>");
    expect(systemText).not.toContain("<mcp_tools_overview>");
    // skills 段装配不受影响（无 fixture skill → 空清单显式语句仍在）
    expect(systemText).toContain("<available_skills>");
  }, 30_000);
});
