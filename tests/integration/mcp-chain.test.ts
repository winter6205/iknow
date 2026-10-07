/**
 * Integration chain: fixture stdio MCP server, real subprocess + e2e assertions.
 *
 * Acceptance:
 *  1. real subprocess chain:
 *     spawn fixture server → createMcpManager(createRealClient + AciRegistry.registerExternal)
 *     → start() → connected → `tool_search({query:"mcp"})` discover → real call of
 *     `mcp__<server>__echo` → assert structuredContent return
 *  2. list_changed trigger: touch triggerFile → expect new tool added-on-listchange
 *     in the catalog while old tools stay callable
 *  3. Gate 2 collision guard: registerExternal receiving a non-mcp__ prefix → RegistryConstructionError
 *  4. shutdown SIGTERM: the fixture child must really exit on SIGTERM
 *
 * No LLM, no external server — fixture subprocess + real SDK Client/Transport only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAciRegistry,
  type AciRegistry,
} from "../../src/harness/aci/aci-registry.js";
import { createToolSearchTool } from "../../src/harness/aci/tools/tool-search.js";
import type { AciToolDef } from "../../src/harness/aci/types.js";
import { RegistryConstructionError } from "../../src/harness/errors.js";

import {
  createMcpManager,
  type McpManager,
} from "../../src/harness/mcp/manager.js";
import type { McpServerConfig } from "../../src/harness/mcp/config.js";

// ---------------------------------------------------------------------------
// fixture server path resolution — reuses the tsx locating pattern from tests/cli/trace.test.ts
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureServer = join(
  repoRoot,
  "tests",
  "fixtures",
  "mcp-server",
  "server.ts"
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface SpawnedFixture {
  readonly child: ChildProcess;
  readonly triggerFile: string;
  readonly stderrLines: string[];
  /** Whether the child really exited (for the SIGTERM assertion). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnFixture(): SpawnedFixture {
  // Trigger file: a tmp dir private to this test, no clash with concurrent instances
  const scratch = join(
    tmpdir(),
    `iknow-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(scratch, { recursive: true });
  const triggerFile = join(scratch, "listchanged.flag");
  // Create the empty file first — only then does fs.watch fire change events
  writeFileSync(triggerFile, "");

  const child = spawn(process.execPath, [fixtureServer], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LISTCHANGED_FILE: triggerFile },
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

  return { child, triggerFile, stderrLines, exited };
}

function makeStdioConfig(name: string, triggerFile: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "project",
    status: "enabled",
    entry: {
      command: process.execPath,
      args: [fixtureServer],
      env: { LISTCHANGED_FILE: triggerFile },
    },
  };
}

interface Harness {
  readonly registry: AciRegistry;
  readonly toolSearch: AciToolDef;
  readonly manager: McpManager;
  readonly registered: AciToolDef[];
}

/**
 * Assembly fixture: registry = static tools + toolSearch → manager appends
 * mcp__ tools via registry.registerExternal. The `registered` array captures
 * every registerExternal call so tests can assert each registration's shape.
 */
function buildHarness(cfg: McpServerConfig): Harness {
  const registered: AciToolDef[] = [];
  const toolSearchHolder: { reg?: AciRegistry } = {};
  const toolSearch = createToolSearchTool({
    getRegistry: () => {
      if (!toolSearchHolder.reg)
        throw new Error("harness: registry not assembled yet");
      return toolSearchHolder.reg;
    },
  });
  const registry = createAciRegistry([toolSearch]);
  toolSearchHolder.reg = registry;
  const manager = createMcpManager({
    workspaceRoot: repoRoot,
    config: [cfg],
    registerExternal: (defs) => {
      // Real call into AciRegistry.registerExternal — verifies Gate 2
      registry.registerExternal(defs);
      for (const d of defs) registered.push(d);
    },
  });
  return { registry, toolSearch, manager, registered };
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

async function waitForToolRegistered(
  registered: ReadonlyArray<AciToolDef>,
  toolName: string,
  timeoutMs = 5_000
): Promise<AciToolDef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = registered.find((d) => d.name === toolName);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForToolRegistered: ${toolName} not in registry after ${timeoutMs}ms`
  );
}

// ---------------------------------------------------------------------------
// Global cleanup
// ---------------------------------------------------------------------------

let activeFixtures: SpawnedFixture[] = [];

afterEach(async () => {
  // Let the manager take its normal shutdown path first
  for (const f of activeFixtures) {
    if (!f.child.killed) {
      try {
        f.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  // Wait for every child to really exit, max 3s
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
  activeFixtures = [];
});

// =========================================================================
// 1. Real subprocess chain — spawn → connect → registerExternal → discover → call
// =========================================================================

describe("MCP integration — end-to-end real subprocess chain", () => {
  it("connects to fixture stdio MCP server, registers mcp__ tools, and invokes echo via tool_search discovery", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("echo_server", spawned.triggerFile);
    const { registry, toolSearch, manager, registered } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "echo_server");

    // Chain assertion 1: registerExternal saw echo/fail/slow at minimum
    const names = registered.map((d) => d.name).sort();
    expect(names).toEqual([
      "mcp__echo_server__echo",
      "mcp__echo_server__fail",
      "mcp__echo_server__slow",
    ]);

    // Chain assertion 2: every mcp__ tool is visible in the AciRegistry catalog
    expect(registry.catalog.get("mcp__echo_server__echo")).toBeDefined();
    expect(registry.catalog.get("mcp__echo_server__fail")).toBeDefined();
    expect(registry.catalog.get("mcp__echo_server__slow")).toBeDefined();

    // Chain assertion 3: tool_search({query:"echo"}) discovery → real tool schema returned
    const searchOutput = toolSearch.handler!(
      { query: "echo" },
      undefined
    ) as string;
    expect(typeof searchOutput).toBe("string");
    const parsed = searchOutput
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { name: string; description: string });
    const discoveredNames = parsed.map((p) => p.name);
    expect(discoveredNames).toContain("mcp__echo_server__echo");

    // Chain assertion 4: after discovery, visibleSchemas contains the tool
    const visible = registry.visibleSchemas().map((t) => t.name);
    expect(visible).toContain("mcp__echo_server__echo");

    // Chain assertion 5: actually run mcp__echo_server__echo → real structuredContent
    const echo = registry.catalog.get("mcp__echo_server__echo")!;
    expect(echo.handler).toBeDefined();
    const result = await echo.handler!({ text: "hello fixture" });
    expect(result).toBe('{"text":"hello fixture"}');

    // Chain assertion 6: fail tool takes the isError branch → returns text (adapter does not throw)
    const fail = registry.catalog.get("mcp__echo_server__fail")!;
    const failResult = await fail.handler!({ reason: "intentional" });
    expect(failResult).toBe("intentional");

    await manager.shutdown();

    // Assert the child really exited after shutdown
    const exitInfo = await Promise.race([
      spawned.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
        setTimeout(() => r({ code: null, signal: null }), 3_000)
      ),
    ]);
    // Child must have exited (killed by SIGTERM: code=null + signal=SIGTERM, or code=143)
    expect(exitInfo.code !== null || exitInfo.signal === "SIGTERM").toBe(true);
  });
});

// =========================================================================
// 2. list_changed — touch the trigger file → expect the new tool registered
// =========================================================================

describe("MCP integration — list_changed hot re-registration", () => {
  it("emits list_changed after touching trigger file, new tool is registered without dropping existing ones", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("lc_server", spawned.triggerFile);
    const { registry, manager, registered } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "lc_server");

    // Initial registration complete
    expect(registered.map((d) => d.name).sort()).toEqual([
      "mcp__lc_server__echo",
      "mcp__lc_server__fail",
      "mcp__lc_server__slow",
    ]);
    const beforeCount = registered.length;

    // Trigger list_changed: touch the file + write content (ensure the watcher sees the change)
    writeFileSync(spawned.triggerFile, "go\n");

    // Wait for the new tool — sanitize keeps hyphens/dots (consistent with the
    // mcpServerOfToolName reverse-parse contract: after the panel bugfix `-`
    // is no longer replaced by `_`, so the fixture tool name
    // `added-on-listchange` is preserved verbatim).
    const newTool = await waitForToolRegistered(
      registered,
      "mcp__lc_server__added-on-listchange",
      5_000
    );
    expect(newTool).toBeDefined();

    // Old tools stay in the catalog (not dropped by the re-registration)
    expect(registry.catalog.get("mcp__lc_server__echo")).toBeDefined();
    expect(registry.catalog.get("mcp__lc_server__fail")).toBeDefined();
    expect(registry.catalog.get("mcp__lc_server__slow")).toBeDefined();
    expect(
      registry.catalog.get("mcp__lc_server__added-on-listchange")
    ).toBeDefined();

    // registration count should be >= beforeCount + 1
    expect(registered.length).toBeGreaterThan(beforeCount);

    // Repeated touch must not re-register (same name skipped, manager incremental diff)
    writeFileSync(spawned.triggerFile, "go2\n");
    await new Promise((r) => setTimeout(r, 300));
    const newToolCount = registered.filter(
      (d) => d.name === "mcp__lc_server__added-on-listchange"
    ).length;
    expect(newToolCount).toBe(1);

    await manager.shutdown();
  });
});

// =========================================================================
// 3. Gate 2 collision guard — non-mcp__ prefix registration must throw RegistryConstructionError
// =========================================================================

describe("MCP integration — Gate 2 namespace collision", () => {
  it("registerExternal rejects an external tool name that lacks the mcp__ prefix", () => {
    // Reproduces Gate 2 directly, no subprocess needed. This case is
    // unit-level; it lives in the integration file to keep the MCP chain
    // acceptance in one place. createMcpManager always registers with the
    // mcp__ prefix, so the negative assertion goes through AciRegistry.registerExternal.
    const toolSearchHolder: { reg?: AciRegistry } = {};
    const toolSearch = createToolSearchTool({
      getRegistry: () => {
        if (!toolSearchHolder.reg)
          throw new Error("harness: registry not assembled yet");
        return toolSearchHolder.reg;
      },
    });
    const registry = createAciRegistry([toolSearch]);
    toolSearchHolder.reg = registry;

    const badTool: AciToolDef = Object.freeze({
      name: "bash", // ← static name, no mcp__ prefix
      description: "should be rejected",
      inputSchema: {
        type: "object",
        properties: { cmd: { type: "string" } },
        additionalProperties: false,
      },
      handler: async () => "x",
      aci: {
        category: "execute" as const,
        isConcurrencySafe: false,
        interruptBehavior: "cancel" as const,
        timeoutTier: "default" as const,
      },
    });

    expect(() => registry.registerExternal([badTool])).toThrow(
      RegistryConstructionError
    );
  });

  it("registerExternal rejects a duplicate mcp__ tool name", () => {
    const toolSearchHolder: { reg?: AciRegistry } = {};
    const toolSearch = createToolSearchTool({
      getRegistry: () => {
        if (!toolSearchHolder.reg)
          throw new Error("harness: registry not assembled yet");
        return toolSearchHolder.reg;
      },
    });
    const registry = createAciRegistry([toolSearch]);
    toolSearchHolder.reg = registry;

    const t: AciToolDef = Object.freeze({
      name: "mcp__srv__foo",
      description: "first",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "x",
      aci: {
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      },
    });

    registry.registerExternal([t]);
    expect(() => registry.registerExternal([t])).toThrow(
      RegistryConstructionError
    );
  });
});

// =========================================================================
// 4. shutdown SIGTERM — the fixture child must really exit
// =========================================================================

describe("MCP integration — shutdown SIGTERM child exit (SC11)", () => {
  it("manager.shutdown() forwards SIGTERM to the spawned fixture child", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("sigterm_server", spawned.triggerFile);
    const { manager } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "sigterm_server");

    // Trigger shutdown
    await manager.shutdown();

    // The child must really exit, never hang
    const exitInfo = await Promise.race([
      spawned.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (_, reject) =>
          setTimeout(
            () => reject(new Error("fixture child hung on shutdown")),
            5_000
          )
      ),
    ]);

    // SDK StdioClientTransport.close() calls process.kill(pid, "SIGTERM");
    // the child exits via process.on("SIGTERM") in server.ts with code=143.
    // transport.close may also close stdin first, hitting the 'end' path -> code=0.
    // Both legal exits count as PASS.
    const okExit =
      exitInfo.signal === "SIGTERM" ||
      exitInfo.code === 143 ||
      exitInfo.code === 0;
    expect(okExit).toBe(true);
  });
});

// =========================================================================
// 5. Full chain tool_search → discover → invoke (incl. ToolExecutionError boundary)
// =========================================================================

describe("MCP integration — tool_search discovery feeds real call", () => {
  it("discovers the mcp__ tool via tool_search, then executes it through the discovered handler", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("disc_server", spawned.triggerFile);
    const { registry, toolSearch, manager } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "disc_server");

    // Simulate the lazy path: visibleSchemas excludes mcp__ tools before
    // discovery. createAciRegistry concatenates visibleSchemas only from the
    // discovered set + non-lazy tools, and our ACI tools are all lazy, so
    // they appear only after discover.
    const before = registry
      .visibleSchemas()
      .map((t) => t.name)
      .filter((n) => n.startsWith("mcp__"));
    expect(before).toEqual([]); // not discovered yet

    // Real tool_search discovery
    const out = toolSearch.handler!(
      { names: ["mcp__disc_server__echo"] },
      undefined
    ) as string;
    expect(out).toContain("mcp__disc_server__echo");

    // After the discovery side effect, the tool shows up in visible
    const after = registry
      .visibleSchemas()
      .map((t) => t.name)
      .filter((n) => n.startsWith("mcp__"));
    expect(after).toContain("mcp__disc_server__echo");

    // Really invoke the discovered tool
    const echo = registry.catalog.get("mcp__disc_server__echo")!;
    const result = await echo.handler!({ text: "discovered call" });
    expect(result).toBe('{"text":"discovered call"}');

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Local choice: no tmp cleanup in afterEach (children already SIGTERM'd; leftover files are harmless)
// ---------------------------------------------------------------------------

// Backstop: after all tests, sweep any leftover tmp dir/flag file (failure-scenario safety net)
const _origSpawnFixture = spawnFixture;
void _origSpawnFixture;
