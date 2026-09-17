/**
 * build-engine egress 装配接线（ADR-0097 / T7）。
 *
 * 钉住的不变式：交互入口（chat）的 bash 工厂必须拿到
 *   - `egressPolicyFactory`（settings.isolation.network 段 → EgressPolicyInput；
 *     无配置段 → 工厂恒返 undefined = 无缝断网）；
 *   - `askApproval`（既有 AskUser 转写为 `(host) => Promise<boolean>`，T6
 *     批准流的 ask inlet）。
 *
 * TUI 实测回归（2026-09-17）：R1 repair 只接了消费侧（bash.ts / manager /
 * verify），装配源头（build-engine → registry → createBashTool）漏接 ——
 * 交互入口的允许集永远读不到、批准流不可达。本测试钉住源头接线不回退。
 *
 * 手法：module-mock bash.js（registry 的 named import 落到 spy；registry
 * 本体保持真实），buildHarnessEngine 走真实装配 —— 与
 * build-engine-bash-wiring.test.ts 同款。
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type {
  McpClientHandle,
  McpManagerOptions,
} from "../../src/harness/mcp/manager.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

function makeEnv(apiKey: string, productRoot: string): IknowEnv {
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
    workspaceRoot: productRoot,
    productRoot,
  } as unknown as IknowEnv;
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

interface BuildOpts {
  readonly settings?: IknowSettings;
}

async function buildChat(opts: BuildOpts): Promise<BuiltEngine> {
  const productRoot = await mkdtemp(join(tmpdir(), "iknow-egress-wire-prod-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-egress-wire-"));
  roots.push(productRoot, workspaceRoot);
  await plantProjectMcp(productRoot);
  const built = await buildHarnessEngine({
    env: makeEnv("sk-test-egress-wire", productRoot),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(productRoot, "home"),
    cwd: productRoot,
    workspaceRoot,
    productRoot,
    skipCountTokens: true,
    ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    createMcpManager: (managerOpts: McpManagerOptions) =>
      createMcpManager(managerOpts),
    createMcpClient: FAKE_CLIENT,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

/** bash 工厂调用里属于引擎构造点（registry 透传 liveTaskRoot）的那部分。 */
function engineBashCallOpts(): Record<string, unknown>[] {
  return vi
    .mocked(createBashTool)
    .mock.calls.map(
      ([, bashOpts]) => (bashOpts ?? {}) as Record<string, unknown>
    )
    .filter((bashOpts) => bashOpts.liveTaskRoot !== undefined);
}

describe("buildHarnessEngine — egress 装配接线 (ADR-0097 / T7)", () => {
  it("chat surface threads egressPolicyFactory + askApproval to the bash factory", async () => {
    await buildChat({});
    const calls = engineBashCallOpts();
    expect(calls.length).toBeGreaterThan(0);
    for (const bashOpts of calls) {
      expect(bashOpts.egressPolicyFactory).toBeTypeOf("function");
      expect(bashOpts.askApproval).toBeTypeOf("function");
    }
  });

  it("settings.isolation.network 在场 → factory 返回 preset policy 形状", async () => {
    await buildChat({
      settings: {
        isolation: {
          network: {
            allowedDomains: ["example.com"],
            deniedDomains: [],
          },
        },
      } as unknown as IknowSettings,
    });
    const calls = engineBashCallOpts();
    expect(calls.length).toBeGreaterThan(0);
    const factory = calls[0]!.egressPolicyFactory as () => unknown;
    const policy = factory() as {
      allowedDomains: string[];
      allowlistSource?: string;
      commandLabel: string;
    };
    expect(policy.allowedDomains).toEqual(["example.com"]);
    expect(policy.allowlistSource).toBe("preset");
    expect(typeof policy.commandLabel).toBe("string");
  });

  it("settings.isolation.network 缺省 → factory 恒返 undefined（无缝断网 fail-closed）", async () => {
    await buildChat({});
    const calls = engineBashCallOpts();
    expect(calls.length).toBeGreaterThan(0);
    const factory = calls[0]!.egressPolicyFactory as () => unknown;
    expect(factory()).toBeUndefined();
  });

  it("askApproval 转写 AskUser：host 进 ctx.tool=egress-domain-approval，结果透传", async () => {
    const askUser = vi.fn(async () => true);
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-egress-ask-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-egress-ask-ws-"));
    roots.push(productRoot, workspaceRoot);
    await plantProjectMcp(productRoot);
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-egress-ask", productRoot),
      askUser,
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
    const calls = engineBashCallOpts();
    expect(calls.length).toBeGreaterThan(0);
    const askApproval = calls[0]!.askApproval as (
      host: string
    ) => Promise<boolean>;
    const approved = await askApproval("api.example.com");
    expect(approved).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(1);
    const askCalls = askUser.mock.calls as unknown as Array<
      [
        {
          readonly tool: string;
          readonly input: unknown;
          readonly summaryHint: string;
        },
      ]
    >;
    const ctx = askCalls[0]![0];
    expect(ctx.tool).toBe("egress-domain-approval");
    expect(ctx.input).toEqual({ host: "api.example.com" });
    expect(typeof ctx.summaryHint).toBe("string");
  });
});
