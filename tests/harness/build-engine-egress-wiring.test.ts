/**
 * buildHarnessEngine egress assembly wiring (ADR-0097).
 *
 * Pinned invariant: the interactive entry (chat) bash factory must receive
 *   - `egressPolicyFactory` (allowlist = preset ∪ user additions from
 *     settings.isolation.network, ADR-0104; when the section is absent the
 *     factory still returns a preset-only builtin policy, so the egress
 *     session always starts, closing the ADR-0097 lifecycle-table gap);
 *   - `askApproval` (the existing AskUser transcribed as
 *     `(host) => Promise<boolean>` — the approval flow's ask inlet).
 *
 * Regression backstory: an earlier fix only wired the consuming side
 * (bash.ts / manager / verify) and missed the assembly source
 * (build-engine → registry → createBashTool) — the interactive entry could
 * never read the allowlist and the approval flow was unreachable. This test
 * pins the source-side wiring against regressions.
 *
 * Technique: module-mock bash.js (the registry's named import lands on the
 * spy; the registry itself stays real) while buildHarnessEngine runs real
 * assembly — same pattern as build-engine-bash-wiring.test.ts.
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
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../src/harness/sandbox/egress/preset-domains.ts";
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

/** The bash-factory calls belonging to engine construction points (the registry threads liveTaskRoot through). */
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

  it("settings.isolation.network 在场 → factory 返回 preset ∪ 用户增量 policy 形状 (source persisted)", async () => {
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
    expect(policy.allowedDomains).toEqual([
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
      "example.com",
    ]);
    expect(policy.allowlistSource).toBe("persisted");
    expect(typeof policy.commandLabel).toBe("string");
  });

  it("settings.isolation.network 缺省 → factory 恒返 preset-only policy（断言反转：旧行为 undefined；ADR-0104 生命周期落差闭合）", async () => {
    // Regression-flip pin for the lifecycle-table gap (spec invariant 3
    // references it explicitly; no separate textual exception): the old
    // implementation returned undefined from the factory when the network
    // section was absent ⇒ the egress session never started ⇒ first-sight
    // domain approval was dead at the inlet. The not-`undefined` assertion
    // plus the askApproval wiring below together pin the gap closed; it must
    // not regress.
    await buildChat({});
    const calls = engineBashCallOpts();
    expect(calls.length).toBeGreaterThan(0);
    const factory = calls[0]!.egressPolicyFactory as () => unknown;
    // ADR-0097 lifecycle-table condition 1 (allowlist non-empty) is always
    // true thanks to the preset ⇒ the undefined branch is unreachable on the
    // production assembly path (spec invariant 3).
    expect(factory()).not.toBeUndefined();
    const policy = factory() as {
      allowedDomains: string[];
      deniedDomains: string[];
      allowlistSource?: string;
    };
    expect(policy).toBeDefined();
    expect(policy.allowedDomains).toEqual([...BUILTIN_PRESET_ALLOWED_DOMAINS]);
    expect(policy.deniedDomains).toEqual([]);
    expect(policy.allowlistSource).toBe("builtin");
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
