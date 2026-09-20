/**
 * buildHarnessEngine single-root MCP wiring.
 *
 * Acceptance:
 *  1. One resolveMcpRoots return value drives loadMcpConfig, createMcpManager
 *     cwd, the ACI/sandbox FS root, and BuiltEngine.mcpRoots.
 *  2. An explicit sandboxRoot that disagrees with the resolved workspaceRoot →
 *     root_mismatch, with no createMcpManager call and nothing spawned.
 *  3. ask does not wire MCP (no manager / no mcpRoots / no mcp__* tools).
 *  4. A missing or invalid root fails closed before any MCP side effect.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { McpLifecycleError } from "../../src/harness/errors.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
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
  };
}

async function plantProjectMcp(
  root: string,
  serverName: string
): Promise<void> {
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(
    join(root, ".iknow", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        [serverName]: { type: "stdio", command: "node" },
      },
    }),
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

describe("buildHarnessEngine — T5 resolveMcpRoots single-root wiring", () => {
  it("one resolve drives config root, manager cwd, ACI FS root, and BuiltEngine.mcpRoots", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t5-product-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-t5-task-"));
    roots.push(productRoot, workspaceRoot);

    await plantProjectMcp(productRoot, "from-product");
    // Plant a decoy config in the task worktree — it must never be read.
    await plantProjectMcp(workspaceRoot, "from-task");

    const captured: McpManagerOptions[] = [];
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-wire-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(productRoot, "home"),
      cwd: productRoot,
      workspaceRoot,
      productRoot,
      // This file verifies mcpRoots derivation and the fail-closed gate, not
      // tool overflow or index demotion (dedicated tests:
      // build-engine-tool-overflow.test.ts, disclosure-index-align/).
      // Assembly-time countTokens is bypassed; see the BuildEngineOpts.skipCountTokens comment for seam semantics.
      skipCountTokens: true,
      createMcpManager: (opts) => {
        captured.push(opts);
        return createMcpManager(opts);
      },
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
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    expect(built.mcpRoots).toEqual({
      workspaceRoot,
      mcpConfigRoot: productRoot,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.workspaceRoot).toBe(workspaceRoot);
    const names = captured[0]!.config.map((s) => s.name);
    expect(names).toContain("from-product");
    expect(names).not.toContain("from-task");

    // ACI FS root = resolved workspaceRoot: out-of-root paths fail closed.
    const readFile = built.deps.registry.get("read_file");
    expect(readFile).toBeDefined();
    await expect(
      readFile!.handler(
        { path: join(productRoot, "secret.txt") },
        { signal: new AbortController().signal }
      )
    ).rejects.toThrow();
  });

  it("explicit sandboxRoot mismatch → root_mismatch; no createMcpManager", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t5-mm-prod-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-t5-mm-task-"));
    const foreignSandbox = await mkdtemp(join(tmpdir(), "iknow-t5-mm-sbx-"));
    roots.push(productRoot, workspaceRoot, foreignSandbox);

    let managerCalls = 0;
    let caught: unknown;
    try {
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-mismatch-1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(productRoot, "home"),
        cwd: productRoot,
        workspaceRoot,
        productRoot,
        sandboxRoot: foreignSandbox,
        skipCountTokens: true, // Same as above: verifies fail-closed, not overflow or index demotion.
        createMcpManager: (opts) => {
          managerCalls += 1;
          return createMcpManager(opts);
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpLifecycleError);
    expect((caught as McpLifecycleError).kind).toBe("root_mismatch");
    expect(managerCalls).toBe(0);
  });

  it("ask surface: no mcpManager, no mcpRoots, no mcp__* tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-ask-"));
    roots.push(root);
    await plantProjectMcp(root, "should-not-load");

    let managerCalls = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-ask-1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      userHome: join(root, "home"),
      cwd: root,
      workspaceRoot: root,
      productRoot: root,
      skipCountTokens: true, // Same as above: verifies the ask-surface gate, not overflow or index demotion.
      createMcpManager: (opts) => {
        managerCalls += 1;
        return createMcpManager(opts);
      },
    });

    expect(built.mcpManager).toBeUndefined();
    expect(built.mcpRoots).toBeUndefined();
    expect(managerCalls).toBe(0);
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names.filter((n) => n.startsWith("mcp__"))).toEqual([]);
    expect(names).not.toContain("list_mcp_resources");
    expect(names).not.toContain("read_mcp_resource");
  });

  it("invalid workspaceRoot → fail-closed before createMcpManager", async () => {
    let managerCalls = 0;
    let caught: unknown;
    try {
      await buildHarnessEngine({
        env: makeEnv("sk-test-t5-missing-1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(tmpdir(), "iknow-t5-missing-home"),
        cwd: tmpdir(),
        workspaceRoot: "relative/not/absolute",
        productRoot: tmpdir(),
        skipCountTokens: true, // Same as above: verifies fail-closed, not overflow or index demotion.
        createMcpManager: (opts) => {
          managerCalls += 1;
          return createMcpManager(opts);
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpLifecycleError);
    expect((caught as McpLifecycleError).kind).toBe("invalid_cwd");
    expect(managerCalls).toBe(0);
  });
});
