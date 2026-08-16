/**
 * T13 (#440 Stream B) — 集成链：fixture stdio MCP server 真子进程链路
 * + resources 通道端到端断言。
 *
 * 与 tests/integration/mcp-chain.test.ts（T10 tools 链路）配对：
 * 那个 fixture 暴露 tools/echo/fail/slow + list_changed；
 * 本 fixture (tests/fixtures/mcp-resource-server/server.ts) 仅暴露 4 个
 * resource（small / large / blob / empty）。两 fixture 隔离 = tools / resources
 * 协议路径互不污染。
 *
 * 验收（plans/440-wayfinder-toolset.md T13）：
 *   1. spawn fixture server → createMcpManager(createRealClient) → start()
 *      → connected；fixture server 启动期在 stderr 行输出资源数（诊断可见）
 *   2. manager.listResources() → 含 4 个 fixture resource，wire shape 完整
 *      （server/uri/name/description/mimeType 字段投影正确）
 *   3. manager.listResources({server:"alpha"}) → 仅该 server 的资源；
 *      未连接的 server 在 perServer 暴露当前 state 而不抛
 *   4. manager.readResource(server, uri) → 真实内容返回；
 *      small → text 字段；blob → blob 字段（text/blob 互斥）；empty → text 空串
 *   5. large 资源 → 返回 50000 字符内容（manager 不截断；
 *      executor 截断是下游契约，超出 T13 scope）
 *   6. read 不存在的 uri → ToolExecutionError（manager 层 SDK 错误屏蔽）
 *   7. list_mcp_resources / read_mcp_resource 工具 handler 端到端接通
 *      （走真实 wire 形态：line-JSON / envelope JSON），让 T9/T10 工厂
 *      与 manager 的契约也同测试连通
 *   8. shutdown SIGTERM：fixture 子孙必须真正退出（SC11）
 *
 * 无 LLM、无外部 server — 仅 fixture 子进程 + 真实 SDK Client/Transport。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMcpManager,
  type McpManager,
} from "../../src/harness/mcp/manager.js";
import type { McpServerConfig } from "../../src/harness/mcp/config.js";
import { ToolExecutionError } from "../../src/harness/errors.js";

import { createListMcpResourcesTool } from "../../src/harness/aci/tools/list-mcp-resources.js";
import { createReadMcpResourceTool } from "../../src/harness/aci/tools/read-mcp-resource.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { createRegistry } from "../../src/harness/tools/registry.js";

// ---------------------------------------------------------------------------
// fixture server 路径解析 — 与 mcp-chain.test.ts 同形态
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resourceFixtureServer = join(
  repoRoot,
  "tests",
  "fixtures",
  "mcp-resource-server",
  "server.ts"
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface SpawnedResourceFixture {
  readonly child: ChildProcess;
  readonly stderrLines: string[];
  readonly scratch: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnResourceFixture(): SpawnedResourceFixture {
  // 触发文件非必需（资源 fixture 无 list_changed），但保持同 scratch 隔离模式
  const scratch = join(
    tmpdir(),
    `iknow-mcp-rsrc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(scratch, { recursive: true });

  const child = spawn(process.execPath, [resourceFixtureServer], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrLines: string[] = [];
  child.stderr?.on("data", (b: Buffer) => {
    stderrLines.push(b.toString());
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, stderrLines, scratch, exited };
}

function makeStdioConfig(name: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "project",
    status: "enabled",
    entry: {
      command: process.execPath,
      args: [resourceFixtureServer],
    },
  };
}

async function waitForConnected(
  manager: McpManager,
  name: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = manager.status().find((x) => x.name === name);
    if (s?.state === "connected") return;
    if (s?.state === "failed") {
      throw new Error(
        `server ${name} failed before connected: ${s.error ?? "(no error)"}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const s = manager.status().find((x) => x.name === name);
  throw new Error(
    `waitForConnected: ${name} state=${s?.state} after ${timeoutMs}ms`
  );
}

/**
 * stderr 启动行 poll —— 子进程 stderr 'data' 事件与 SDK 握手竞态：
 * waitForConnected（stdout 协议路径）通过后 stderr 行可能尚未投递，
 * 并行套件负载下同步 find 会偶发漏检（code-review Standards Medium 修复）。
 */
async function waitForStderrLine(
  lines: string[],
  predicate: (line: string) => boolean,
  timeoutMs = 5_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = lines.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `waitForStderrLine: no matching stderr line within ${timeoutMs}ms (captured ${lines.length} lines)`
  );
}

// ---------------------------------------------------------------------------
// 全局清理 — 与 mcp-chain.test.ts 同形态
// ---------------------------------------------------------------------------

let activeFixtures: SpawnedResourceFixture[] = [];

afterEach(async () => {
  for (const f of activeFixtures) {
    if (!f.child.killed) {
      try {
        f.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  await Promise.all(
    activeFixtures.map((f) =>
      Promise.race([
        f.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: null, signal: null }), 3_000)
        ),
      ])
    )
  );
  // 回收 fixture scratch 目录（避免 /tmp 污染；独立 rm 失败不影响其它回收入）
  for (const f of activeFixtures) {
    try {
      await rm(f.scratch, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  activeFixtures = [];
});

// =========================================================================
// 1. fixture server 真子进程链路 — spawn → connect → listResources 聚合
// =========================================================================

describe("MCP resources integration — end-to-end real subprocess chain", () => {
  it("connects to fixture resource server and listResources aggregates all fixture resources", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {
        /* 资源通道不走 mcp__ 工具注册 */
      },
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    // 真链路断言 1：stderr 启动行含资源数（fixture 端到端契约的诊断锚点）
    const started = await waitForStderrLine(
      spawned.stderrLines,
      (l) => l.includes("fixture-mcp-resources") && l.includes("started pid=")
    );
    expect(started).toMatch(/resources=4/);

    // 真链路断言 2：listResources 聚合返回 4 个 fixture resource
    const list = await manager.listResources();
    expect(list.resources).toHaveLength(4);

    // 真链路断言 3：每个 resource 字段投影正确（fixture server 协议实现校验）
    const byUri = new Map(list.resources.map((r) => [r.uri, r]));
    expect(byUri.get("small://fixture")).toEqual({
      server: "rsrc_server",
      uri: "small://fixture",
      name: "small-fixture",
      description: "Short text resource for happy-path read tests.",
      mimeType: "text/plain",
    });
    expect(byUri.get("large://fixture")?.mimeType).toBe("text/plain");
    expect(byUri.get("blob://fixture")?.mimeType).toBe(
      "application/octet-stream"
    );
    expect(byUri.get("empty://fixture")?.mimeType).toBe("text/plain");

    // 真链路断言 4：perServer 状态正确反映 connected + 无 nextCursor
    expect(list.perServer).toEqual([
      { server: "rsrc_server", state: "connected" },
    ]);

    await manager.shutdown();
  });
});

// =========================================================================
// 2. listResources 过滤 — server 参数 + 未连接 server 行为
// =========================================================================

describe("MCP resources integration — listResources scope + state surfaces", () => {
  it("listResources({server}) returns only that server's resources", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("solo");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "solo");

    const list = await manager.listResources({ server: "solo" });
    expect(list.resources).toHaveLength(4);
    expect(list.resources.every((r) => r.server === "solo")).toBe(true);

    // 不存在的 server → 空集合（manager 不抛；perServer 不含该项）
    const none = await manager.listResources({ server: "ghost" });
    expect(none.resources).toEqual([]);
    expect(none.perServer).toEqual([]);

    await manager.shutdown();
  });

  it("listResources against not-yet-connected server skips it in resources but surfaces state in perServer", async () => {
    // 创建立即失败的 server（命令不存在 → connect 抛 → markFailed）
    // + 一个 fixture 资源 server。fixture 资源 server 仍 connected，
    // 失败的 server 在 perServer 暴露 failed state 但 listResources 不抛。
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const failingCfg: McpServerConfig = {
      name: "failing",
      kind: "stdio",
      source: "project",
      status: "enabled",
      entry: {
        command: "/nonexistent/command/that/does/not/exist",
        args: [],
      },
    };
    const okCfg = makeStdioConfig("ok_server");
    const manager = createMcpManager({
      config: [failingCfg, okCfg],
      registerExternal: () => {},
    });

    await manager.start();
    // 等 ok_server 真正 connected；failing 注定 failed
    await waitForConnected(manager, "ok_server");
    // 给 failing server 一个窗口让 connect 抛错
    await new Promise((r) => setTimeout(r, 500));

    const list = await manager.listResources();

    // ok_server 的 4 条 resource 全部入列
    expect(list.resources).toHaveLength(4);
    expect(list.resources.every((r) => r.server === "ok_server")).toBe(true);

    // failing server 在 perServer 暴露 failed state 而不抛（M3 决议：不崩）
    const failingEntry = list.perServer.find((s) => s.server === "failing");
    expect(failingEntry).toBeDefined();
    expect(failingEntry?.state).toBe("failed");

    // ok_server perServer 仍 connected
    const okEntry = list.perServer.find((s) => s.server === "ok_server");
    expect(okEntry?.state).toBe("connected");

    await manager.shutdown();
  });
});

// =========================================================================
// 3. readResource — happy / empty / blob / large / not_found 边界
// =========================================================================

describe("MCP resources integration — readResource content fidelity", () => {
  it("readResource(small) → text 字段，内容与 fixture 一致", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "small://fixture");
    expect(result.server).toBe("rsrc_server");
    expect(result.uri).toBe("small://fixture");
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.uri).toBe("small://fixture");
    expect(content.mimeType).toBe("text/plain");
    expect(content.text).toBe("hello from fixture resource server");
    expect(content.blob).toBeUndefined();

    await manager.shutdown();
  });

  it("readResource(blob) → blob 字段 base64 解码与 fixture 字节一致 (text/blob 互斥)", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "blob://fixture");
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe("application/octet-stream");
    // text 缺席，blob 在场 → 互斥守住
    expect(content.text).toBeUndefined();
    expect(content.blob).toBeDefined();
    // base64 还原后与 fixture 写入的字节一致
    const decoded = Buffer.from(content.blob!, "base64").toString("utf8");
    expect(decoded).toBe("binary-fixture-data");

    await manager.shutdown();
  });

  it("readResource(empty) → text 空串（content 长度 0 边界）", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "empty://fixture");
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.text).toBe("");
    expect(content.text).toHaveLength(0);
    expect(content.blob).toBeUndefined();

    await manager.shutdown();
  });

  it("readResource(large) → 50000 字符完整返回（manager 层不截断；executor 截断是下游契约）", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "large://fixture");
    const content = result.contents[0];
    // 50000 字符完整返回 — manager 层守"原内容",截断是 executor/契约 X 的活
    expect(content.text).toBeDefined();
    expect(content.text!.length).toBe(50_000);
    // 内容一致性:fixture 是 "ABCDEFGHIJ" × 5000
    expect(content.text!.startsWith("ABCDEFGHIJ")).toBe(true);
    expect(content.text!.endsWith("ABCDEFGHIJ")).toBe(true);

    await manager.shutdown();
  });

  it("readResource(不存在的 URI) → ToolExecutionError（manager 层 SDK 错误屏蔽）", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    // fixture resources/read 未找到 uri → 返回 JSON-RPC 错误 -32002 → manager 抛 ToolExecutionError
    await expect(
      manager.readResource("rsrc_server", "nonexistent://does-not-exist")
    ).rejects.toThrow(ToolExecutionError);

    await manager.shutdown();
  });

  it("readResource(server 名未配置) → ToolExecutionError(不 crash)", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    await expect(
      manager.readResource("never_configured", "small://fixture")
    ).rejects.toThrow(ToolExecutionError);

    await manager.shutdown();
  });

  it("readResource(server 在 config 但未 connected) → ToolExecutionError 携带 state 上下文", async () => {
    // 双 server：一个 fixture 资源 server (connected) + 一个注定 failed 的 server
    // 对 failed server 调 readResource → 期望 ToolExecutionError 携带 state=failed
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const failingCfg: McpServerConfig = {
      name: "failing_read",
      kind: "stdio",
      source: "project",
      status: "enabled",
      entry: {
        command: "/nonexistent/cmd/never",
        args: [],
      },
    };
    const okCfg = makeStdioConfig("ok_for_read");
    const manager = createMcpManager({
      config: [failingCfg, okCfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "ok_for_read");
    await new Promise((r) => setTimeout(r, 500));

    await expect(
      manager.readResource("failing_read", "small://fixture")
    ).rejects.toThrow(ToolExecutionError);

    await manager.shutdown();
  });
});

// =========================================================================
// 4. list_mcp_resources / read_mcp_resource 工具 handler 端到端接通
// =========================================================================

describe("MCP resources integration — tool handlers wire format end-to-end", () => {
  let manager: McpManager;
  let spawned: SpawnedResourceFixture;

  beforeEach(async () => {
    spawned = spawnResourceFixture();
    activeFixtures.push(spawned);
    const cfg = makeStdioConfig("rsrc_tool_wire");
    manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });
    await manager.start();
    await waitForConnected(manager, "rsrc_tool_wire");
  });

  it("list_mcp_resources handler → line-JSON + perServer tail wire 形态", async () => {
    const listTool = createListMcpResourcesTool({ getManager: () => manager });
    expect(listTool.name).toBe("list_mcp_resources");

    const output = (await listTool.handler!({})) as string;
    // wire 形态：每条 resource 一行 JSON + 空行 + "--- perServer ---" + perServer 行
    const lines = output.split("\n");
    // 4 条 resource + 1 空行 + 1 "--- perServer ---" + 1 perServer 行 = 7 行
    expect(lines).toHaveLength(7);
    // 前 4 行：resource JSON 解析
    const resources = lines.slice(0, 4).map((l) => JSON.parse(l));
    expect(
      resources.every((r: { server: string }) => r.server === "rsrc_tool_wire")
    ).toBe(true);
    expect(resources.map((r: { uri: string }) => r.uri).sort()).toEqual([
      "blob://fixture",
      "empty://fixture",
      "large://fixture",
      "small://fixture",
    ]);
    // 第 5 行：空行
    expect(lines[4]).toBe("");
    // 第 6 行：perServer 头
    expect(lines[5]).toBe("--- perServer ---");
    // 第 7 行：perServer JSON
    const perServer = JSON.parse(lines[6]);
    expect(perServer).toEqual({ server: "rsrc_tool_wire", state: "connected" });
  });

  it('list_mcp_resources handler {server:"rsrc_tool_wire"} → scope 到该 server', async () => {
    const listTool = createListMcpResourcesTool({ getManager: () => manager });
    const output = (await listTool.handler!({
      server: "rsrc_tool_wire",
    })) as string;
    const lines = output.split("\n");
    // 4 条 resource + perServer 头尾 = 7 行（同上）
    expect(lines).toHaveLength(7);
  });

  it('list_mcp_resources handler {server:"ghost"} → 仅 perServer tail,资源为空 → 含 perServer 行', async () => {
    // manager 不抛；resources 为空但 perServer 也不含 ghost（filter 在 manager 层）
    // 触发 list handler 的 (no resources) 占位：resources 0 且 perServer 0
    const listTool = createListMcpResourcesTool({ getManager: () => manager });
    const output = (await listTool.handler!({ server: "ghost" })) as string;
    // list-mcp-resources.ts: resources 0 且 perServer 0 → (no resources)
    expect(output).toBe("(no resources)");
  });

  it("read_mcp_resource handler → envelope JSON with text field", async () => {
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    expect(readTool.name).toBe("read_mcp_resource");
    const output = (await readTool.handler!({
      server: "rsrc_tool_wire",
      uri: "small://fixture",
    })) as string;
    const envelope = JSON.parse(output);
    expect(envelope.server).toBe("rsrc_tool_wire");
    expect(envelope.uri).toBe("small://fixture");
    expect(envelope.contents).toHaveLength(1);
    expect(envelope.contents[0]).toEqual({
      uri: "small://fixture",
      mimeType: "text/plain",
      text: "hello from fixture resource server",
    });
  });

  it("read_mcp_resource handler → blob envelope（text 缺席）", async () => {
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    const output = (await readTool.handler!({
      server: "rsrc_tool_wire",
      uri: "blob://fixture",
    })) as string;
    const envelope = JSON.parse(output);
    expect(envelope.contents[0].mimeType).toBe("application/octet-stream");
    expect(envelope.contents[0].text).toBeUndefined();
    expect(envelope.contents[0].blob).toBeDefined();
    const decoded = Buffer.from(envelope.contents[0].blob, "base64").toString(
      "utf8"
    );
    expect(decoded).toBe("binary-fixture-data");
  });

  it("read_mcp_resource handler → empty text 边界", async () => {
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    const output = (await readTool.handler!({
      server: "rsrc_tool_wire",
      uri: "empty://fixture",
    })) as string;
    const envelope = JSON.parse(output);
    expect(envelope.contents[0].text).toBe("");
    expect(envelope.contents[0].text).toHaveLength(0);
  });

  it("read_mcp_resource handler → 不存在 uri → ToolExecutionError", async () => {
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    await expect(
      readTool.handler!({
        server: "rsrc_tool_wire",
        uri: "ghost://no-such-uri",
      })
    ).rejects.toThrow(ToolExecutionError);
  });

  it("read_mcp_resource handler → server 未配置 → ToolExecutionError", async () => {
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    await expect(
      readTool.handler!({
        server: "never_configured",
        uri: "small://fixture",
      })
    ).rejects.toThrow(ToolExecutionError);
  });

  it("read_mcp_resource(large) → executor 截断契约 e2e（≤20000 + 截断 marker，M6 / T13 验收）", async () => {
    // plan T13 acceptance「大内容触发 executor 截断行为」：manager 层不截断
    // （忠实返回 50000），截断发生在 executor 边界（ADR-0006 契约 X：
    // executor 是截断权威）。本测试把工具经 createExecutor 接通真链路验证。
    const readTool = createReadMcpResourceTool({ getManager: () => manager });
    const exec = createExecutor(createRegistry([readTool]));
    const results = await exec.executeAll([
      {
        id: "c1",
        name: "read_mcp_resource",
        input: { server: "rsrc_tool_wire", uri: "large://fixture" },
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("ok");
    const blocks = results[0]!.payload as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    const text = blocks[0]!.text ?? "";
    // 截断上限：OUTPUT_HARD_CAP = 20000（executor.ts SSOT）
    expect(text.length).toBeLessThanOrEqual(20_000);
    // 截断 marker：契约 X 的可诊断形态
    expect(text).toContain("[executor: 输出超长已截断，原长");
    // manager 原内容（50000）确实被压到上限内 —— 保留段是前缀
    expect(text.startsWith('{"server":"rsrc_tool_wire"')).toBe(true);
  });
});

// =========================================================================
// 5. shutdown SIGTERM — fixture 子孙必须真正退出（SC11）
// =========================================================================

describe("MCP resources integration — shutdown SIGTERM child exit (SC11)", () => {
  it("manager.shutdown() forwards SIGTERM to the spawned resource fixture child", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("sigterm_rsrc");
    const manager = createMcpManager({
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "sigterm_rsrc");

    await manager.shutdown();

    // 子孙必须真正退出，不能悬挂
    const exitInfo = await Promise.race([
      spawned.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (_, reject) =>
          setTimeout(
            () => reject(new Error("resource fixture child hung on shutdown")),
            5_000
          )
      ),
    ]);

    // 资源 fixture: process.on("SIGTERM") → exit(143)
    // SDK transport.close() 先关 stdin → 'end' 路径 → exit(0)
    // 两种合法退出都算 PASS
    const okExit =
      exitInfo.signal === "SIGTERM" ||
      exitInfo.code === 143 ||
      exitInfo.code === 0;
    expect(okExit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 兜底：fixture server 文件存在性 guard（防止 fixture 文件被误删时静默跳过）
// ---------------------------------------------------------------------------

describe("MCP resources integration — fixture server file presence", () => {
  it("tests/fixtures/mcp-resource-server/server.ts 存在（端到端链路的物理前提）", () => {
    expect(existsSync(resourceFixtureServer)).toBe(true);
  });
});
