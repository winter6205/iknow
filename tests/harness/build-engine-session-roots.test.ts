/**
 * T2 (plans/worktree-session-roots.md) — buildHarnessEngine 透出会话三根。
 *
 * 验收:
 *  1. 同一次装配可问出 `productRoot` / `taskRoot` / `installRoot`（ADR-0037 §4）;
 *     `taskRoot` 改绑到 task worktree 时 `productRoot` / `installRoot` 不动。
 *  2. `mcpConfigRoot` 仍等于 `productRoot`（#828 行为不变，MCP 降为消费者）。
 *  3. `installRoot` 锚在 iknow 安装位置，不等于会话根、不等于 `process.cwd()`。
 *  4. ask 面不装配 MCP，但同样透出三根——身份/状态消费者在任何 surface 都
 *     有唯一根来源可问。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { resolveInstallRoot } from "../../src/harness/session-roots.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { McpClientHandle } from "../../src/harness/mcp/manager.ts";

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

const stubClient = (): McpClientHandle => ({
  connect: async () => {},
  listTools: async () => [],
  callTool: async () => ({ result: { content: [] } }),
  close: async () => {},
  onListChanged: () => {},
  onClose: () => {},
  listResources: async () => ({ resources: [] }),
  readResource: async () => ({ contents: [] }),
});

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

async function build(
  overrides: {
    readonly productRoot: string;
    readonly workspaceRoot: string;
    readonly userHome: string;
    readonly surface?: "chat" | "ask";
    readonly installRoot?: string;
  },
  apiKey: string
): Promise<BuiltEngine> {
  const built = await buildHarnessEngine({
    env: makeEnv(apiKey),
    askUser: createNoAskUser(),
    surface: overrides.surface ?? "chat",
    userHome: overrides.userHome,
    cwd: overrides.productRoot,
    workspaceRoot: overrides.workspaceRoot,
    productRoot: overrides.productRoot,
    ...(overrides.installRoot !== undefined
      ? { installRoot: overrides.installRoot }
      : {}),
    createMcpManager,
    createMcpClient: stubClient,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("buildHarnessEngine — session roots (T2)", () => {
  it("answers productRoot / taskRoot / installRoot from one assembly", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-product-"));
    const taskWorktree = await mkdtemp(join(tmpdir(), "iknow-sr-task-"));
    roots.push(productRoot, taskWorktree);

    const built = await build(
      {
        productRoot,
        workspaceRoot: taskWorktree,
        userHome: join(productRoot, "home"),
      },
      "sk-test-session-roots-1"
    );

    expect(built.sessionRoots.productRoot).toBe(productRoot);
    expect(built.sessionRoots.taskRoot).toBe(taskWorktree);
    expect(built.sessionRoots.installRoot).toBe(resolveInstallRoot());
  });

  it("keeps productRoot and installRoot still while taskRoot follows the rebind", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-stable-"));
    const taskWorktree = await mkdtemp(join(tmpdir(), "iknow-sr-rebound-"));
    const userHome = join(productRoot, "home");
    roots.push(productRoot, taskWorktree);

    const beforeRebind = await build(
      { productRoot, workspaceRoot: productRoot, userHome },
      "sk-test-session-roots-2a"
    );
    const afterRebind = await build(
      { productRoot, workspaceRoot: taskWorktree, userHome },
      "sk-test-session-roots-2b"
    );

    expect(afterRebind.sessionRoots.taskRoot).toBe(taskWorktree);
    expect(afterRebind.sessionRoots.productRoot).toBe(
      beforeRebind.sessionRoots.productRoot
    );
    expect(afterRebind.sessionRoots.installRoot).toBe(
      beforeRebind.sessionRoots.installRoot
    );
  });

  it("keeps mcpConfigRoot equal to productRoot (MCP is a consumer)", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-mcp-prod-"));
    const taskWorktree = await mkdtemp(join(tmpdir(), "iknow-sr-mcp-task-"));
    roots.push(productRoot, taskWorktree);
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8"
    );

    const built = await build(
      {
        productRoot,
        workspaceRoot: taskWorktree,
        userHome: join(productRoot, "home"),
      },
      "sk-test-session-roots-3"
    );

    expect(built.mcpRoots).toEqual({
      workspaceRoot: built.sessionRoots.taskRoot,
      mcpConfigRoot: built.sessionRoots.productRoot,
    });
  });

  it("anchors installRoot at the iknow install location, not a session root", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-install-"));
    const taskWorktree = await mkdtemp(
      join(tmpdir(), "iknow-sr-install-task-")
    );
    roots.push(productRoot, taskWorktree);

    const built = await build(
      {
        productRoot,
        workspaceRoot: taskWorktree,
        userHome: join(productRoot, "home"),
      },
      "sk-test-session-roots-4"
    );

    const { installRoot, productRoot: p, taskRoot } = built.sessionRoots;
    expect(installRoot).not.toBe(p);
    expect(installRoot).not.toBe(taskRoot);
    expect(existsSync(join(installRoot, "package.json"))).toBe(true);
  });

  it("honours the installRoot test seam", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-seam-"));
    const fakeInstall = await mkdtemp(join(tmpdir(), "iknow-sr-seam-install-"));
    roots.push(productRoot, fakeInstall);

    const built = await build(
      {
        productRoot,
        workspaceRoot: productRoot,
        userHome: join(productRoot, "home"),
        installRoot: fakeInstall,
      },
      "sk-test-session-roots-5"
    );

    expect(built.sessionRoots.installRoot).toBe(fakeInstall);
  });

  it("exposes every root on the ask surface too (no MCP assembly)", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-sr-ask-"));
    roots.push(productRoot);

    const built = await build(
      {
        productRoot,
        workspaceRoot: productRoot,
        userHome: join(productRoot, "home"),
        surface: "ask",
      },
      "sk-test-session-roots-6"
    );

    expect(built.mcpRoots).toBeUndefined();
    expect(built.sessionRoots).toEqual({
      productRoot,
      taskRoot: productRoot,
      installRoot: resolveInstallRoot(),
      projectIdentityRoot: productRoot,
    });
  });
});
