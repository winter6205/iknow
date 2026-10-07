/**
 * Shared fixture for the full-assembly prefix-stability matrix (assertion 2).
 *
 * Each scenario assembles a minimal harness (stub adapter / stub client /
 * real registry + resolver) and asserts that `promptTools()` + `deps.system()`
 * are deep-equal for the two adjacent turns before and after the scenario
 * event. Tool-surface comparison is element-wise (name + every schema field);
 * system is compared via full JSON serialization (same shape as
 * tests/harness/mcp/prefix-stability.test.ts).
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { McpClientHandle } from "../../../src/harness/mcp/manager.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Basic env / client stand-ins
// ---------------------------------------------------------------------------

export function makeMatrixEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-prefix-matrix",
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

export function makeInstantClient(
  tools: readonly {
    name: string;
    description?: string;
  }[]
): McpClientHandle {
  return {
    connect: async () => {},
    listTools: async () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description ?? "test tool",
        inputSchema: { type: "object", properties: {} },
      })) as never,
    callTool: async () => ({ result: { content: [] } as never }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

/** A client whose connect only succeeds after an external release (scenario-a window control). */
export function makeGatedClient(): {
  handle: McpClientHandle;
  release: () => void;
} {
  let releaseGate!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const handle: McpClientHandle = {
    connect: async () => {
      await released;
    },
    listTools: async () =>
      [
        {
          name: "alpha",
          description: "gated tool",
          inputSchema: { type: "object", properties: {} },
        },
      ] as never,
    callTool: async () => ({ result: { content: [] } as never }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
  return { handle, release: releaseGate };
}

/** A client whose connect never resolves (scenario-a timeout branch). */
export function makeNeverResolvingClient(): McpClientHandle {
  return {
    connect: async () => {
      await new Promise<never>(() => {});
    },
    listTools: async () => [] as never,
    callTool: async () => ({ result: { content: [] } as never }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

// ---------------------------------------------------------------------------
// Assertion-2 dual-surface helpers
// ---------------------------------------------------------------------------

/**
 * Element-wise tools comparison: name arrays deep-equal + every ToolDef
 * JSON-serialized deep-equal (handler functions serialize to undefined, so
 * both turns stay shape-identical and the comparison remains strict).
 */
export function assertToolsDeepEqual(
  before: ReadonlyArray<ToolDef>,
  after: ReadonlyArray<ToolDef>,
  label: string
): void {
  assert.deepEqual(
    after.map((t) => t.name),
    before.map((t) => t.name),
    `${label}: tools 名字序必须逐位一致`
  );
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(
      JSON.stringify(after[i]),
      JSON.stringify(before[i]),
      `${label}: tools[${i}] (${before[i]?.name}) 必须逐字段一致`
    );
  }
}

export function assertSystemDeepEqual(
  before: string | undefined,
  after: string | undefined,
  label: string
): void {
  assert.equal(after, before, `${label}: system 必须逐字节一致`);
}

/** One adjacent-two-turn assertion: snapshot before → scenario event → snapshot after → deep-equal. */
export async function assertAdjacentTurnsStable(
  built: BuiltEngine,
  label: string,
  event?: () => Promise<void> | void
): Promise<void> {
  const toolsBefore = built.deps.promptTools!();
  const systemBefore = await built.deps.system!();
  if (event !== undefined) await event();
  const toolsAfter = built.deps.promptTools!();
  const systemAfter = await built.deps.system!();
  assertToolsDeepEqual(toolsBefore, toolsAfter, label);
  assertSystemDeepEqual(systemBefore, systemAfter, label);
}

// ---------------------------------------------------------------------------
// Temp-directory helpers
// ---------------------------------------------------------------------------

export async function makeTempRoot(
  tag: string
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `iknow-b7-${tag}-`));
  return {
    root,
    cleanup: async () => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Minimal chat-surface assembly (tmp home / tmp cwd, no MCP config). */
export async function buildMinimalChatEngine(
  root: string,
  extra: Parameters<typeof buildHarnessEngine>[0] extends infer O
    ? Partial<O>
    : never = {}
): Promise<BuiltEngine> {
  await mkdir(join(root, "home"), { recursive: true });
  const built = await buildHarnessEngine({
    env: makeMatrixEnv(),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: join(root, "home"),
    cwd: root,
    ...extra,
  });
  return built;
}

/** Write a .iknow/mcp.json with the given server names. */
export async function plantMcpConfig(
  root: string,
  servers: readonly string[]
): Promise<void> {
  const entries = servers
    .map((name) => `"${name}": { "type": "stdio", "command": "node" }`)
    .join(", ");
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(
    join(root, ".iknow", "mcp.json"),
    `{ "mcpServers": { ${entries} } }`,
    "utf8"
  );
}
