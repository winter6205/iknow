/**
 * Integration chain: fixture stdio MCP server, real subprocess + resources
 * channel end-to-end assertions.
 *
 * Paired with tests/integration/mcp-chain.test.ts (the tools chain): that
 * fixture exposes echo/fail/slow tools + list_changed; this fixture
 * (tests/fixtures/mcp-resource-server/server.ts) exposes only 4 resources
 * (small / large / blob / empty). Two isolated fixtures = tools / resources
 * protocol paths cannot pollute each other.
 *
 * Acceptance:
 *   1. spawn fixture server → createMcpManager(createRealClient) → start()
 *      → connected; the fixture prints its resource count on a stderr startup
 *      line (diagnostic anchor)
 *   2. manager.listResources() → contains the 4 fixture resources with full
 *      wire shape (server/uri/name/description/mimeType projected correctly)
 *   3. manager.listResources({server:"alpha"}) → that server's resources only;
 *      a not-connected server surfaces its current state in perServer without throwing
 *   4. manager.readResource(server, uri) → real content returned;
 *      small → text field; blob → blob field (text/blob mutually exclusive); empty → text empty string
 *   5. large resource → full 50000-char content (manager does not truncate;
 *      executor truncation is a downstream contract, out of scope here)
 *   6. read of a nonexistent uri → ToolExecutionError (manager hides SDK errors)
 *   7. list_mcp_resources / read_mcp_resource tool handlers wired end-to-end
 *      (real wire formats: line-JSON / envelope JSON), so the factory-vs-manager
 *      contract is exercised through the same test
 *   8. shutdown SIGTERM: the fixture child must really exit
 *
 * No LLM, no external server — fixture subprocess + real SDK Client/Transport.
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
// fixture server path resolution — same shape as mcp-chain.test.ts
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
  // No trigger file needed (resources fixture has no list_changed), but keep the same scratch-isolation pattern
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
 * stderr startup-line poll — the child's stderr 'data' event races the SDK
 * handshake: even after waitForConnected (stdout protocol path) passes, the
 * stderr line may not have been delivered yet, and a synchronous find flakes
 * under parallel-suite load.
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
// Global cleanup — same shape as mcp-chain.test.ts
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
  // Reclaim fixture scratch dirs (no /tmp pollution; a failed rm must not block the others)
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
// 1. Real fixture subprocess chain — spawn → connect → listResources aggregation
// =========================================================================

describe("MCP resources integration — end-to-end real subprocess chain", () => {
  it("connects to fixture resource server and listResources aggregates all fixture resources", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {
        /* the resources channel does not go through mcp__ tool registration */
      },
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    // Chain assertion 1: stderr startup line carries the resource count (diagnostic anchor for the fixture contract)
    const started = await waitForStderrLine(
      spawned.stderrLines,
      (l) => l.includes("fixture-mcp-resources") && l.includes("started pid=")
    );
    expect(started).toMatch(/resources=4/);

    // Chain assertion 2: listResources aggregates the 4 fixture resources
    const list = await manager.listResources();
    expect(list.resources).toHaveLength(4);

    // Chain assertion 3: every resource field projects correctly (validates the fixture server's protocol implementation)
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

    // Chain assertion 4: perServer reflects connected correctly + no nextCursor
    expect(list.perServer).toEqual([
      { server: "rsrc_server", state: "connected" },
    ]);

    await manager.shutdown();
  });
});

// =========================================================================
// 2. listResources filtering — server param + not-connected server behavior
// =========================================================================

describe("MCP resources integration — listResources scope + state surfaces", () => {
  it("listResources({server}) returns only that server's resources", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("solo");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "solo");

    const list = await manager.listResources({ server: "solo" });
    expect(list.resources).toHaveLength(4);
    expect(list.resources.every((r) => r.server === "solo")).toBe(true);

    // Nonexistent server -> empty set (manager does not throw; perServer has no such entry)
    const none = await manager.listResources({ server: "ghost" });
    expect(none.resources).toEqual([]);
    expect(none.perServer).toEqual([]);

    await manager.shutdown();
  });

  it("listResources against not-yet-connected server skips it in resources but surfaces state in perServer", async () => {
    // A server whose command fails immediately (connect throws -> markFailed)
    // plus a fixture resources server. The fixture server stays connected; the
    // failed one surfaces failed state in perServer but listResources does not throw.
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
      workspaceRoot: repoRoot,
      config: [failingCfg, okCfg],
      registerExternal: () => {},
    });

    await manager.start();
    // Wait until ok_server is truly connected; failing is destined to fail
    await waitForConnected(manager, "ok_server");
    // Give the failing server a window for connect to throw
    await new Promise((r) => setTimeout(r, 500));

    const list = await manager.listResources();

    // All 4 ok_server resources are listed
    expect(list.resources).toHaveLength(4);
    expect(list.resources.every((r) => r.server === "ok_server")).toBe(true);

    // failing server exposes failed state in perServer without throwing (must not crash)
    const failingEntry = list.perServer.find((s) => s.server === "failing");
    expect(failingEntry).toBeDefined();
    expect(failingEntry?.state).toBe("failed");

    // ok_server's perServer entry remains connected
    const okEntry = list.perServer.find((s) => s.server === "ok_server");
    expect(okEntry?.state).toBe("connected");

    await manager.shutdown();
  });
});

// =========================================================================
// 3. readResource — happy / empty / blob / large / not_found boundaries
// =========================================================================

describe("MCP resources integration — readResource content fidelity", () => {
  it("readResource(small) → text 字段，内容与 fixture 一致", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
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
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "blob://fixture");
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe("application/octet-stream");
    // text absent, blob present -> mutual exclusion held
    expect(content.text).toBeUndefined();
    expect(content.blob).toBeDefined();
    // base64-decoded bytes match what the fixture wrote
    const decoded = Buffer.from(content.blob!, "base64").toString("utf8");
    expect(decoded).toBe("binary-fixture-data");

    await manager.shutdown();
  });

  it("readResource(empty) → text 空串（content 长度 0 边界）", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
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
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    const result = await manager.readResource("rsrc_server", "large://fixture");
    const content = result.contents[0];
    // Full 50000 chars returned — the manager keeps the original content; truncation is the executor's job
    expect(content.text).toBeDefined();
    expect(content.text!.length).toBe(50_000);
    // Content consistency: the fixture emits "ABCDEFGHIJ" x 5000
    expect(content.text!.startsWith("ABCDEFGHIJ")).toBe(true);
    expect(content.text!.endsWith("ABCDEFGHIJ")).toBe(true);

    await manager.shutdown();
  });

  it("readResource(不存在的 URI) → ToolExecutionError（manager 层 SDK 错误屏蔽）", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("rsrc_server");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "rsrc_server");

    // fixture resources/read cannot find the uri -> JSON-RPC error -32002 -> manager throws ToolExecutionError
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
      workspaceRoot: repoRoot,
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
    // Two servers: a fixture resources server (connected) + one destined to fail.
    // readResource against the failed server -> ToolExecutionError carrying state=failed
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
      workspaceRoot: repoRoot,
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
// 4. list_mcp_resources / read_mcp_resource tool handlers wired end-to-end
// =========================================================================

describe("MCP resources integration — tool handlers wire format end-to-end", () => {
  let manager: McpManager;
  let spawned: SpawnedResourceFixture;

  beforeEach(async () => {
    spawned = spawnResourceFixture();
    activeFixtures.push(spawned);
    const cfg = makeStdioConfig("rsrc_tool_wire");
    manager = createMcpManager({
      workspaceRoot: repoRoot,
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
    // Wire shape: one JSON line per resource + blank line + "--- perServer ---" + perServer lines
    const lines = output.split("\n");
    // 4 resources + 1 blank + 1 "--- perServer ---" + 1 perServer line = 7 lines
    expect(lines).toHaveLength(7);
    // First 4 lines: parse as resource JSON
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
    // Line 5: blank
    expect(lines[4]).toBe("");
    // Line 6: perServer header
    expect(lines[5]).toBe("--- perServer ---");
    // Line 7: perServer JSON
    const perServer = JSON.parse(lines[6]);
    expect(perServer).toEqual({ server: "rsrc_tool_wire", state: "connected" });
  });

  it('list_mcp_resources handler {server:"rsrc_tool_wire"} → scope 到该 server', async () => {
    const listTool = createListMcpResourcesTool({ getManager: () => manager });
    const output = (await listTool.handler!({
      server: "rsrc_tool_wire",
    })) as string;
    const lines = output.split("\n");
    // 4 resources + perServer head/tail = 7 lines (same as above)
    expect(lines).toHaveLength(7);
  });

  it('list_mcp_resources handler {server:"ghost"} → 仅 perServer tail,资源为空 → 含 perServer 行', async () => {
    // manager does not throw; resources empty and perServer has no ghost either (filtering happens in the manager)
    // Exercise the list handler's (no resources) placeholder: 0 resources and 0 perServer
    const listTool = createListMcpResourcesTool({ getManager: () => manager });
    const output = (await listTool.handler!({ server: "ghost" })) as string;
    // list-mcp-resources.ts: 0 resources and 0 perServer -> (no resources)
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
    // Acceptance "large content triggers executor truncation": the manager does
    // not truncate (faithfully returns 50000); truncation happens at the
    // executor boundary (ADR-0006 contract X: executor is the truncation
    // authority). This test wires the tool through createExecutor for the real chain.
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
    const first = results[0]!;
    expect(first.kind).toBe("ok");
    // Discriminated-union narrowing: `expect(x).toBe("ok")` does not narrow,
    // so pin the kind before reading `payload` (which exists only on the ok arm).
    if (first.kind !== "ok") {
      throw new Error(`expected kind=ok, got ${first.kind}`);
    }
    expect(first.payload).toHaveLength(1);
    const block = first.payload[0]!;
    expect(block.type).toBe("text");
    if (block.type !== "text") {
      throw new Error(`expected a text content block, got ${block.type}`);
    }
    const text = block.text;
    // Truncation cap: OUTPUT_HARD_CAP = 20000 (executor.ts SSOT)
    expect(text.length).toBeLessThanOrEqual(20_000);
    // Truncation marker: the diagnosable shape of contract X
    expect(text).toContain("[executor: 输出超长已截断，原长");
    // The manager's original 50000-char content really got capped — the kept segment is a prefix
    expect(text.startsWith('{"server":"rsrc_tool_wire"')).toBe(true);
  });
});

// =========================================================================
// 5. shutdown SIGTERM — the fixture child must really exit
// =========================================================================

describe("MCP resources integration — shutdown SIGTERM child exit (SC11)", () => {
  it("manager.shutdown() forwards SIGTERM to the spawned resource fixture child", async () => {
    const spawned = spawnResourceFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("sigterm_rsrc");
    const manager = createMcpManager({
      workspaceRoot: repoRoot,
      config: [cfg],
      registerExternal: () => {},
    });

    await manager.start();
    await waitForConnected(manager, "sigterm_rsrc");

    await manager.shutdown();

    // The child must really exit, never hang
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

    // Resources fixture: process.on("SIGTERM") -> exit(143)
    // Or SDK transport.close() shuts stdin first -> 'end' path -> exit(0)
    // Both legal exits count as PASS
    const okExit =
      exitInfo.signal === "SIGTERM" ||
      exitInfo.code === 143 ||
      exitInfo.code === 0;
    expect(okExit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backstop: fixture server file-existence guard (no silent skip if the fixture file gets deleted)
// ---------------------------------------------------------------------------

describe("MCP resources integration — fixture server file presence", () => {
  it("tests/fixtures/mcp-resource-server/server.ts 存在（端到端链路的物理前提）", () => {
    expect(existsSync(resourceFixtureServer)).toBe(true);
  });
});
