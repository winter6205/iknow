/**
 * build-engine bash factory 接线 (ADR-0092)。
 *
 * 取代 T4 的 installRoot 透传断言:闭世界读白名单随全局档退役 ——
 * `--bind / /` 让项目工具链本就可见,引擎两处 createDefaultAciRegistry
 * 不再把 `sessionRoots.installRoot` 送进 bash 工厂。installRoot 仍保留为
 * worker bootstrap(tsx loader)的锚,但那不经 bash 工厂。
 *
 * 仍然真实的命题:两处构造点(chat 首次 / ask 路径)都向 bash 工厂透传
 * liveTaskRoot,且不透传任何 installRoot 选项。
 *
 * 手法:module-mock bash.js(registry 的 named import 落到 spy;registry 本体
 * 保持真实,与 tests/harness/aci/registry-workspace-root.test.ts 同款),
 * buildHarnessEngine 走真实装配。
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
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
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

type BuildChatOpts = {
  installRoot?: string;
};

async function buildChat(opts: BuildChatOpts): Promise<BuiltEngine> {
  const productRoot = await mkdtemp(join(tmpdir(), "iknow-bash-wire-prod-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-bash-wire-task-"));
  roots.push(productRoot, workspaceRoot);
  await plantProjectMcp(productRoot);
  const built = await buildHarnessEngine({
    env: makeEnv("sk-test-bash-wire"),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(productRoot, "home"),
    cwd: productRoot,
    workspaceRoot,
    productRoot,
    // 本文件验 bash 工厂接线,不验溢出退场 / 索引降档(专测见
    // build-engine-tool-overflow.test.ts、disclosure-index-align/)。
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

describe("buildHarnessEngine — bash factory wiring (ADR-0092)", () => {
  it("chat surface threads liveTaskRoot and no installRoot to the bash factory", async () => {
    const INSTALL = await mkdtemp(join(tmpdir(), "iknow-bash-wire-root-"));
    roots.push(INSTALL);
    await buildChat({ installRoot: INSTALL });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.liveTaskRoot).toBeDefined();
      expect("installRoot" in call.opts).toBe(false);
    }
  });

  it("ask surface threads liveTaskRoot and no installRoot to the bash factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-bash-wire-ask-"));
    roots.push(root);
    const INSTALL = await mkdtemp(join(tmpdir(), "iknow-bash-wire-ask-root-"));
    roots.push(INSTALL);
    await buildHarnessEngine({
      env: makeEnv("sk-test-bash-wire-ask"),
      askUser: createNoAskUser(),
      surface: "ask",
      userHome: join(root, "home"),
      cwd: root,
      workspaceRoot: root,
      productRoot: root,
      installRoot: INSTALL,
      // 同上:验 bash 工厂接线,不验溢出 / 索引降档。
      skipCountTokens: true,
    });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.liveTaskRoot).toBeDefined();
      expect("installRoot" in call.opts).toBe(false);
    }
  });

  it("threads the resolved userHome as homeRoot to the bash factory (ADR-0092 SC11)", async () => {
    // 工作区档 home ro-bind 的源端必须是本层 resolve 的 `userHome`
    // (opts.userHome ?? homedir())—— 否则 `userHome` 测试缝只改 settings /
    // persona / state,却改不动围栏的 home ro-bind 源端,围栏会挂到真实用户
    // home 上。断言:工厂收到的 homeRoot 逐字等于传入的 userHome。
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-bash-wire-home-"));
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-home-task-")
    );
    roots.push(productRoot, workspaceRoot);
    await plantProjectMcp(productRoot);
    const userHome = join(productRoot, "home");
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-bash-wire-home"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      cwd: productRoot,
      workspaceRoot,
      productRoot,
      skipCountTokens: true,
      createMcpManager: (managerOpts: McpManagerOptions) =>
        createMcpManager(managerOpts),
      createMcpClient: FAKE_CLIENT,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.homeRoot).toBe(userHome);
    }
  });

  it("threads the fsMode holder by identity, never a frozen snapshot (D2)", async () => {
    // D2 batch snapshot 纪律:装配层只透传 holder 对象,handler 入口才
    // `fsMode?.get()` 读一次 —— 运行期 `/config` 翻档必须对下一次 bash 调用
    // 生效。若装配层在此处 `.get()` 求值成字符串(或另造快照),翻档就再也
    // 到不了 bash 工厂。断言:工厂收到的 fsMode 是同一个 holder 对象,翻档后
    // 它自己读到新值。
    const productRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-fsmode-")
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-fsmode-task-")
    );
    roots.push(productRoot, workspaceRoot);
    await plantProjectMcp(productRoot);
    const holder = createFsModeContext("global");
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-bash-wire-fsmode"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(productRoot, "home"),
      cwd: productRoot,
      workspaceRoot,
      productRoot,
      skipCountTokens: true,
      fsMode: holder,
      createMcpManager: (managerOpts: McpManagerOptions) =>
        createMcpManager(managerOpts),
      createMcpClient: FAKE_CLIENT,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.fsMode).toBe(holder);
    }
    holder.set("workspace");
    for (const call of calls) {
      const seen = call.opts.fsMode as { get: () => string };
      expect(seen.get()).toBe("workspace");
    }
  });

  it("omits nothing when fsMode is absent (V1 baseline: holder stays undefined)", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-bash-wire-nofs-"));
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-nofs-task-")
    );
    roots.push(productRoot, workspaceRoot);
    await plantProjectMcp(productRoot);
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-bash-wire-nofs"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(productRoot, "home"),
      cwd: productRoot,
      workspaceRoot,
      productRoot,
      skipCountTokens: true,
      createMcpManager: (managerOpts: McpManagerOptions) =>
        createMcpManager(managerOpts),
      createMcpClient: FAKE_CLIENT,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    const calls = engineBashCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.fsMode).toBeUndefined();
    }
  });
});
