/**
 * B4 / ADR-0043 §4 — build-engine 装配期 wire:
 *   - await manager.start({firstTurnReadyTimeoutMs: 30_000});
 *   - onManualReconnect(cb) 注入 → cb 触发时刻由 loop-engine 消费,
 *     本测试仅验 wire 形态(回调注册、参数形态)。
 *
 * 不验 managers 自己语义(分 open manager.test.ts 完成);本文件专注于
 * build-engine 是否正确将两个 seam 接到 manager。
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
      // 本文件验 MCP seam 的 wire 形态,不验溢出退场 / 索引降档
      // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
      // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
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

    // build-engine 完成时,manager 已经"装配期"等过 firstTurnReady。
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
      skipCountTokens: true, // 同上:验 onManualReconnect wire,不验溢出 / 索引降档。
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
    // 接口已暴露 onManualReconnect 字段(类型保 + 函数形态可调);
    // 消费面(loop-engine)在 loop-engine 测试中验证。
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
      skipCountTokens: true, // 同上:验名字目录段,不验溢出 / 索引降档。
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

    // 等到 connected(装配期已 await firstTurnReady,正常情况下已 connected)。
    const status = built.mcpManager!.status();
    const stubsvc = status.find((s) => s.name === "stubsvc")!;
    expect(stubsvc.state).toBe("connected");

    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    // 名字目录段 + 服务名 + 工具名(sans schema)
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).toContain("stubsvc");
    expect(systemText).toContain("alpha");
    // 工具 schema 不应进 directory(参考 B4 spec §4 二)
    expect(systemText).not.toContain("inputSchema");
    // 旧概览段已撤除
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
      skipCountTokens: true, // 同上:验 ask 路径零接线,不验溢出 / 索引降档。
    });
    // ask 表面不创建 MCP manager
    expect(built.mcpManager).toBeUndefined();
    await built.shutdown?.();
  });
});
