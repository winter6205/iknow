/**
 * Archived 2026-09-13 (ADR-0092 fs isolation modes Round 1): build-engine no
 * longer threads `sessionRoots.installRoot` into the bash factory (the
 * closed-world read channel retired). The still-true wiring — both
 * construction points thread `liveTaskRoot` and no `installRoot` option — is
 * re-certified in `tests/harness/build-engine-bash-wiring.test.ts`.
 *
 * ── original header ──────────────────────────────────────────────────────
 * T4 (plans/closed-world-bash-fence.md) — build-engine installRoot 透传断言。
 *
 * ADR-0037 §9.2 #4:installRoot(iknow 运行时安装根)是闭世界读白名单的合同
 * 读根 —— bash 围栏需要它才能读项目自身工具链(node_modules/.bin)。接线链:
 * build-engine 两处 createDefaultAciRegistry(首次构造 + ask 路径)都传
 * `sessionRoots.installRoot`,registry 再 verbatim 透传给 createBashTool。
 * 不新增状态源:installRoot 仍是 resolveSessionRoots 的既有第四角色。
 *
 * 手法:module-mock bash.js(registry 的 named import 落到 spy;registry 本体
 * 保持真实,与 tests/harness/aci/registry-workspace-root.test.ts 同款),
 * buildHarnessEngine 走真实装配(chat = 首次构造点,ask = ask 路径构造点)。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// registry.ts 的 named import 在 load 时解析到本 spy;其余工厂保持真实。
vi.mock("../../src/harness/aci/tools/bash.js", () => ({
  createBashTool: vi.fn(() => ({
    name: "bash",
    description: "stub",
    inputSchema: { type: "object" },
    handler: async () => ({}),
    aci: {
      category: "execute",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "build",
    },
  })),
}));

import { createBashTool } from "../../src/harness/aci/tools/bash.ts";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { resolveInstallRoot } from "../../src/harness/session-roots.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { IknowEnv } from "../../src/config/env.ts";
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

async function plantProjectMcp(root: string): Promise<void> {
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(
    join(root, ".iknow", "mcp.json"),
    JSON.stringify({
      mcpServers: { stub: { type: "stdio", command: "node" } },
    }),
    "utf8"
  );
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.mocked(createBashTool).mockClear();
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

/** bash 工厂调用里属于引擎构造点(registry 会透传 liveTaskRoot)的那部分。 */
function engineBashCalls(): Array<{ opts: Record<string, unknown> }> {
  return vi
    .mocked(createBashTool)
    .mock.calls.map(([, opts]) => ({
      opts: (opts ?? {}) as Record<string, unknown>,
    }))
    .filter((call) => call.opts.liveTaskRoot !== undefined);
}

const FAKE_CLIENT = (): McpClientHandle => ({
  connect: async () => {},
  listTools: async () => [],
  callTool: async () => ({ result: { content: [] } }),
  close: async () => {},
  onListChanged: () => {},
  onClose: () => {},
  listResources: async () => ({ resources: [] }),
  readResource: async () => ({ contents: [] }),
});

async function buildChat(opts: { installRoot?: string }): Promise<BuiltEngine> {
  const productRoot = await mkdtemp(join(tmpdir(), "iknow-t4-install-prod-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-t4-install-task-"));
  roots.push(productRoot, workspaceRoot);
  await plantProjectMcp(productRoot);
  const built = await buildHarnessEngine({
    env: makeEnv("sk-test-t4-install"),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(productRoot, "home"),
    cwd: productRoot,
    workspaceRoot,
    productRoot,
    // 本文件验 installRoot 透传到 bash 工厂,不验溢出退场 / 索引降档
    // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
    // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
    skipCountTokens: true,
    ...(opts.installRoot !== undefined
      ? { installRoot: opts.installRoot }
      : {}),
    createMcpManager: (managerOpts: McpManagerOptions) =>
      createMcpManager(managerOpts),
    createMcpClient: FAKE_CLIENT,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("buildHarnessEngine — installRoot threaded to the bash factory (T4)", () => {
  it("chat surface (first construction) threads sessionRoots.installRoot verbatim", async () => {
    const INSTALL = await mkdtemp(join(tmpdir(), "iknow-t4-install-root-"));
    roots.push(INSTALL);
    await buildChat({ installRoot: INSTALL });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.installRoot).toBe(INSTALL);
    }
  });

  it("ask surface threads sessionRoots.installRoot verbatim", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-install-ask-"));
    roots.push(root);
    const INSTALL = await mkdtemp(join(tmpdir(), "iknow-t4-install-ask-root-"));
    roots.push(INSTALL);
    await buildHarnessEngine({
      env: makeEnv("sk-test-t4-install-ask"),
      askUser: createNoAskUser(),
      surface: "ask",
      userHome: join(root, "home"),
      cwd: root,
      workspaceRoot: root,
      productRoot: root,
      installRoot: INSTALL,
      // 同上:验 installRoot 透传,不验溢出 / 索引降档。
      skipCountTokens: true,
    });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.installRoot).toBe(INSTALL);
    }
  });

  it("installRoot omitted → SSOT fallback resolveInstallRoot() is threaded (no silent empty)", async () => {
    await buildChat({});
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.installRoot).toBe(resolveInstallRoot());
    }
  });
});
