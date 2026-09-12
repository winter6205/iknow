/**
 * T5 (plans/worktree-mcp-rebind-lifecycle.md) — buildHarnessEngine 单点根接线。
 *
 * 验收:
 *  1. 一次 resolveMcpRoots 的返回值同时驱动 loadMcpConfig、createMcpManager cwd、
 *     ACI/sandbox FS root 与 BuiltEngine.mcpRoots。
 *  2. 显式 sandboxRoot 与解析出的 workspaceRoot 不一致 → root_mismatch，
 *     且不调用 createMcpManager / 不 spawn。
 *  3. ask 不装配 MCP（无 manager / 无 mcpRoots / 无 mcp__*）。
 *  4. 缺根 / 非法根在任何 MCP side effect 之前 fail-closed。
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
    // task worktree 放一份诱饵配置 — 不得被读。
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
      // 本文件验 mcpRoots 派生与 fail-closed 门禁,不验溢出退场 / 索引降档
      // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
      // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
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

    // ACI FS root = resolved workspaceRoot：越界路径 fail-closed。
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
        skipCountTokens: true, // 同上:验 fail-closed,不验溢出 / 索引降档。
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
      skipCountTokens: true, // 同上:验 ask surface 门禁,不验溢出 / 索引降档。
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
        skipCountTokens: true, // 同上:验 fail-closed,不验溢出 / 索引降档。
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
