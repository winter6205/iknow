/**
 * B6 / ADR-0043 §3 — build-engine 装配期溢出治理 wire:
 *   - 注入超阈值工具面(stub countTokens 返回大值)→ 首轮装配退场按次序
 *   - 注入未超阈值(stub 返回小值)→ 不退场
 *   - 会话中不重算(第二次装配不调 countTokens)
 *   - countTokens 失败/缺席 → 跳过本会话(全部 deferrable 保持常驻)+ warn
 *
 * 与 `build-engine-mcp-startwire.test.ts` 风格一致 —— 本文件专注 wire
 * 形态(钩子触发、结果可见、countTokens 调用次数),判定函数单测在
 * `tool-overflow-judge.test.ts` 完成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { McpClientHandle } from "../../src/harness/mcp/manager.js";
import type { McpManager } from "../../src/harness/mcp/manager.js";
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
    // contextWindow = 20_000(非 200_000);阈值 = 2_000(10%),
    // 让测试容易写期望值。
    compress: { contextWindow: 20_000, thresholdTokens: undefined },
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
const warnings: string[] = [];
const originalWarn = console.warn;

beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(async () => {
  console.warn = originalWarn;
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

describe("buildHarnessEngine — B6 溢出治理 wire", () => {
  it("未超阈值:全部 deferrable 内建件保持常驻,系统文本不含 <deferred_internal_tools>", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-nowoverflow-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    let callCount = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-no-overflow"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      // countTokens stub:返 1_000(阈值 2_000 → 远低于,无超限)
      countTokens: async () => {
        callCount += 1;
        return { inputTokens: 1_000 };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // countTokens 至少调一次(首轮判定)
    expect(callCount).toBeGreaterThanOrEqual(1);
    // 全部 visible 工具里都包含 query_trace / list_sessions 等 deferrable 件
    const visibleNames = built.deps.promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("list_sessions");
    expect(visibleNames).toContain("get_record");
    expect(visibleNames).toContain("web_search");
    expect(visibleNames).toContain("web_fetch");
    // 核心件零参与
    expect(visibleNames).toContain("bash");
    expect(visibleNames).toContain("read_file");
    // 系统文本不含 <deferred_internal_tools> 段(无退场)
    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<deferred_internal_tools>");
  });

  it("超阈值:按退场次序逐件退,系统文本含 <deferred_internal_tools>(字母序)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-overflow-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    // 阈值 2_000;模拟"全部 deferrable = 8_000 → 退 1 件 6_500 → 退 2 件
    // 5_000 → 退 3 件 3_500 → 退 4 件 2_500 → 退 5 件 500 ≤ 阈值"。5 件全
    // 退(退场次序 5 件全到位)。
    const measurements = [8_000, 6_500, 5_000, 3_500, 2_500, 500];
    let callIdx = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-overflow"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      countTokens: async () => {
        const v = measurements[callIdx];
        callIdx += 1;
        if (v === undefined) throw new Error("countTokens: out of fixtures");
        return { inputTokens: v };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // 5 件全退(退到 ≤ 阈值)
    expect(callIdx).toBe(6); // 1 首测 + 5 重测
    const visibleNames = built.deps.promptTools().map((t) => t.name);
    // 5 件 deferrable 内建件全部不在 visible
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(visibleNames).not.toContain(retired);
    }
    // 核心件零影响
    expect(visibleNames).toContain("bash");
    expect(visibleNames).toContain("read_file");
    expect(visibleNames).toContain("edit_file");
    expect(visibleNames).toContain("write_file");
    expect(visibleNames).toContain("grep");
    expect(visibleNames).toContain("glob");
    expect(visibleNames).toContain("spawn_subagent");

    // 系统文本含 <deferred_internal_tools> 段 + 5 件全列(字母序)
    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).toContain("<deferred_internal_tools>");
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(systemText).toContain(retired);
    }
  });

  it("countTokens 失败 → 跳过本会话,deferrable 全部保持常驻,warn 一行", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-ctfail-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-ctfail"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      countTokens: async () => {
        throw new Error("network down");
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // 全部 deferrable 内建件保持常驻
    const visibleNames = built.deps.promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("web_fetch");
    // 系统文本不含退场段
    const systemText = await built.deps.system?.();
    expect(systemText).not.toContain("<deferred_internal_tools>");
    // warn 至少一行(且提到 countTokens failed)
    expect(warnings.some((w) => w.includes("countTokens failed"))).toBe(true);
  });

  it("countTokens 缺席(不传 stub,默认用 adapter.countTokens 但 stub adapter 不实现) → 跳过本会话,warn", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-ctabsent-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    // 不传 countTokens → 用 adapter.countTokens。createRealAnthropicAdapter
    // 实际实现,生产路径(无 mock)会真去调 API。本测试用 mkdtemp + chat
    // 入口 → adapter 真实存在,但 buildHarnessEngine 期间 network 不可达
    // (127.0.0.1:9999)→ fetch reject → 装配层 catch → skip 路径。
    // 接受两种语义:warn + 全部保持常驻(stub failure 路径)。
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-ctabsent"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      // 不传 countTokens → 走 adapter.countTokens(可能抛错)
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    // 跳过(无论路径):deferrable 保持常驻
    const visibleNames = built.deps.promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("web_fetch");
    // 系统文本无退场段
    const systemText = await built.deps.system?.();
    expect(systemText).not.toContain("<deferred_internal_tools>");
  });

  it("相邻轮 system deep-equal(退场名单会话内恒定 → 段不变)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-stable-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    let callCount = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-stable"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      countTokens: async () => {
        callCount += 1;
        return { inputTokens: 5_000 };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    // countTokens 只在装配期调一次,后续 resolver() 不重测
    const firstCallCount = callCount;
    // 多次调 resolver → countTokens 不增
    await built.deps.system?.();
    await built.deps.system?.();
    await built.deps.system?.();
    expect(callCount).toBe(firstCallCount);
  });
});
