/**
 * buildHarnessEngine bash-factory wiring (ADR-0092).
 *
 * Replaces the old installRoot pass-through assertion: the closed-world read
 * whitelist was retired with the global tier, so `--bind / /` already exposes
 * the project toolchain and neither createDefaultAciRegistry call feeds
 * `sessionRoots.installRoot` into the bash factory. installRoot remains the
 * worker-bootstrap (tsx loader) anchor, but that path never goes through the
 * bash factory.
 *
 * Still-true proposition: both construction points (chat first / ask path)
 * thread liveTaskRoot to the bash factory and pass no installRoot option.
 *
 * Technique: module-mock bash.js so the registry's named import resolves to
 * the spy while the registry itself stays real (same pattern as
 * tests/harness/aci/registry-workspace-root.test.ts); buildHarnessEngine runs
 * the real assembly.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// registry.ts's named import resolves to this spy at load time; all other factories stay real.
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
import { WORKSPACE_ROOT_ENV_KEY } from "../../src/config/workspace-root.ts";
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
    // Roots are supplied explicitly to buildHarnessEngine; the env
    // side keeps its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
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

/** The bash-factory calls belonging to engine construction points (the registry threads liveTaskRoot through). */
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
    // This file verifies bash factory wiring, not tool overflow or index
    // demotion (dedicated tests: build-engine-tool-overflow.test.ts, disclosure-index-align/).
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
      // Same as above: verifies bash factory wiring, not overflow or index demotion.
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
    // The workspace-tier home ro-bind source must be the `userHome` resolved
    // at this layer (opts.userHome ?? homedir()) — otherwise the `userHome`
    // test seam would only move settings/persona/state while the fence's
    // ro-bind source still pointed at the real user home. Assert: the
    // homeRoot received by the factory equals the passed userHome verbatim.
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
    // Batch snapshot discipline: the assembly layer passes the holder object
    // through; only the handler entry reads `fsMode?.get()` once — a runtime
    // `/config` tier flip must take effect on the next bash call. If assembly
    // evaluated `.get()` to a string here (or made its own snapshot), the
    // flip could never reach the bash factory. Assert: the fsMode received by
    // the factory is the same holder object, and after a flip it reads the
    // new value.
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

  it("threads the env SSOT root — not raw process.env — to the bash factory", async () => {
    // The protected-target fence's name-pattern scan scope resolves from the
    // ENV SSOT (`loadIknowEnv`'s `envOptional`, which merges process.env AND
    // `.env` / `.env.local`); `config/workspace-root.ts` documents that the
    // resolver never reads process.env itself — callers DI the Record.
    //
    // The regression this pins: the bash fence resolved its scan scope from a
    // RAW `process.env[IKNOW_WORKSPACE_ROOT]` while read_file / trace / worker
    // assemblies anchored on `env.workspaceRoot`. A `.env`-configured session
    // therefore scanned `process.cwd()` in the fence and the configured root
    // everywhere else — two protection surfaces in one session, silently.
    //
    // The two roots are made to DISAGREE on purpose, so the assertion can only
    // pass if the value reaching the fence came from the env SSOT. Asserting
    // "the fixture root shows up" would pass under either implementation; this
    // pins WHICH root, which is the whole defect.
    const envSsoRoot = await mkdtemp(join(tmpdir(), "iknow-bash-wire-sso-"));
    const processEnvRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-procenv-")
    );
    const productRoot = await mkdtemp(
      join(tmpdir(), "iknow-bash-wire-ssoprod-")
    );
    roots.push(envSsoRoot, processEnvRoot, productRoot);
    const previous = process.env[WORKSPACE_ROOT_ENV_KEY];
    process.env[WORKSPACE_ROOT_ENV_KEY] = processEnvRoot;
    try {
      const built = await buildHarnessEngine({
        // The env SSOT's workspaceRoot — what `.env` would have produced.
        // Deliberately NOT `processEnvRoot`.
        env: { ...makeEnv("sk-test-bash-wire-sso"), workspaceRoot: envSsoRoot },
        askUser: createNoAskUser(),
        surface: "ask",
        userHome: join(productRoot, "home"),
        cwd: productRoot,
        workspaceRoot: envSsoRoot,
        productRoot,
        skipCountTokens: true,
      });
      shutdowns.push(async () => {
        if (built.shutdown) await built.shutdown();
      });
      const calls = engineBashCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.opts.workspaceRoot).toBe(envSsoRoot);
      }
    } finally {
      if (previous === undefined) {
        delete process.env[WORKSPACE_ROOT_ENV_KEY];
      } else {
        process.env[WORKSPACE_ROOT_ENV_KEY] = previous;
      }
    }
  });
});
