/**
 * ADR-0119 / specs/yolo-mode.md — the yolo holder pass-through in
 * `buildHarnessEngine` (assembly + threading segment).
 *
 * Invariants pinned (Contract §3: the `BuildEngineOpts.yolo?: YoloContext` holder shape):
 *   - the holder is passed **by reference** to every bash-factory construction
 *     point (main-chain registry / ask-path registry / worker-derived registry) —
 *     same as `fsMode`: the assembly layer never evaluates `.get()` into a
 *     snapshot, so a runtime flip is what the next handler call sees;
 *   - the holder also reaches the subagent spawn factory (read fresh per spawn ->
 *     the `IKNOW_YOLO` env wire, route 4 of spec §6);
 *   - absent -> the factory side still receives `undefined` (V1 baseline: the key
 *     is not produced).
 *
 * Same technique as `tests/harness/build-engine-bash-wiring.test.ts`: module-mock
 * the bash factory (the registry's named import lands on the spy) and the subagent
 * spawn factory, keep the registry itself real, and let `buildHarnessEngine` run
 * its real assembly.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/harness/aci/tools/bash.js", () => ({
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

// Only the factory is swapped for a spy (other exports stay real:
// resolveSubagentWorkerSpawnArgs etc. are still consumed by build-engine /
// manager). The assertion surface = the opts build-engine hands to it.
vi.mock("../../../src/harness/subagent/spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/subagent/spawn.js")
    >();
  return {
    ...actual,
    createDefaultSubAgentSpawn: vi.fn(actual.createDefaultSubAgentSpawn),
  };
});

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createDefaultSubAgentSpawn } from "../../../src/harness/subagent/spawn.ts";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.ts";
import { createYoloContext } from "../../../src/harness/sandbox/yolo.ts";
import { createMcpManager } from "../../../src/harness/mcp/manager.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type {
  McpClientHandle,
  McpManagerOptions,
} from "../../../src/harness/mcp/manager.ts";

function makeEnv(apiKey: string): IknowEnv {
  return {
    // Both roots are supplied explicitly by buildHarnessEngine's assembly args;
    // the env side keeps its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
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

const FAKE_CLIENT = (): McpClientHandle => ({
  connect: async () => {},
  listTools: async () => [],
  callTool: async () => ({ result: { content: [] } }),
  close: async () => {},
  onListChanged: () => {},
  onClose: async () => {},
  listResources: async () => ({ resources: [] }),
  readResource: async () => ({ contents: [] }),
});

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.mocked(createBashTool).mockClear();
  vi.mocked(createDefaultSubAgentSpawn).mockClear();
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

type ChatEngineOpts = {
  readonly yolo?: ReturnType<typeof createYoloContext>;
  readonly fsMode?: ReturnType<typeof createFsModeContext>;
};

/** Assemble a chat-surface engine; the two holder axes are injected optionally. */
async function buildChat(opts: ChatEngineOpts = {}): Promise<BuiltEngine> {
  const productRoot = await mkdtemp(join(tmpdir(), "yolo-wire-prod-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "yolo-wire-task-"));
  roots.push(productRoot, workspaceRoot);
  await plantProjectMcp(productRoot);
  const built = await buildHarnessEngine({
    env: makeEnv("sk-test-yolo-wire"),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(productRoot, "home"),
    cwd: productRoot,
    workspaceRoot,
    productRoot,
    // This file verifies the yolo pass-through, not overflow exit / index downgrade
    // (each has its own dedicated test).
    skipCountTokens: true,
    ...(opts.yolo !== undefined ? { yolo: opts.yolo } : {}),
    ...(opts.fsMode !== undefined ? { fsMode: opts.fsMode } : {}),
    createMcpManager: (managerOpts: McpManagerOptions) =>
      createMcpManager(managerOpts),
    createMcpClient: FAKE_CLIENT,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

/** The opts received by every bash-factory call (main chain / ask path / worker-derived — three construction points). */
function bashFactoryOpts(): Array<Record<string, unknown>> {
  return vi
    .mocked(createBashTool)
    .mock.calls.map(([, opts]) => (opts ?? {}) as Record<string, unknown>);
}

/** The opts received by every subagent-spawn factory call (factory args are optional; normalized to an object). */
function spawnFactoryOpts(): Array<Record<string, unknown>> {
  return vi
    .mocked(createDefaultSubAgentSpawn)
    .mock.calls.map(
      ([opts]) => (opts ?? {}) as unknown as Record<string, unknown>
    );
}

describe("buildHarnessEngine — yolo holder pass-through (ADR-0119)", () => {
  it("the holder reaches every bash-factory construction point by reference (not a .get() snapshot)", async () => {
    const holder = createYoloContext(false);
    await buildChat({ yolo: holder });
    const opts = bashFactoryOpts();
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.yolo).toBe(holder);
    }
    // After flipping the holder the same object reads the new value — runtime
    // `/yolo` does not rebuild the engine.
    holder.set(true);
    for (const o of opts) {
      expect((o.yolo as { get: () => boolean }).get()).toBe(true);
    }
  });

  it("the holder also reaches the subagent spawn factory (read fresh per spawn -> env wire)", async () => {
    const holder = createYoloContext(true);
    await buildChat({ yolo: holder });
    const spawnOpts = spawnFactoryOpts();
    expect(spawnOpts.length).toBeGreaterThan(0);
    for (const o of spawnOpts) {
      expect(o.yolo).toBe(holder);
    }
  });

  it("holder absent -> undefined on both factory faces (V1 baseline: the key is not produced)", async () => {
    await buildChat();
    for (const o of bashFactoryOpts()) {
      expect(o.yolo).toBeUndefined();
    }
    const spawnOpts = spawnFactoryOpts();
    expect(spawnOpts.length).toBeGreaterThan(0);
    for (const o of spawnOpts) {
      expect(o.yolo).toBeUndefined();
    }
  });

  it("yolo and fsMode each arrive by reference in the same factory opts (the two channels do not cross)", async () => {
    const yolo = createYoloContext(true);
    const fsMode = createFsModeContext("workspace");
    await buildChat({ yolo, fsMode });
    const opts = bashFactoryOpts();
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.yolo).toBe(yolo);
      expect(o.fsMode).toBe(fsMode);
    }
    // After flipping both axes, the factory face still holds the same pair of
    // holders (the engine was not rebuilt).
    fsMode.set("global");
    yolo.set(false);
    for (const o of opts) {
      expect((o.yolo as { get: () => boolean }).get()).toBe(false);
      expect((o.fsMode as { get: () => string }).get()).toBe("global");
    }
  });
});
