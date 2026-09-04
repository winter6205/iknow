/**
 * B7 / spec model-prefix-layering SC2 断言② 总装矩阵共享 fixture。
 *
 * 每个场景用最小 harness 装配(stub adapter / stub client / 真 registry +
 * resolver),断言「场景事件发生前」与「发生后」相邻两轮的
 * `promptTools()` + `deps.system()` deep-equal。工具面比较元素级
 * (name + schema 逐字段),system 全文 JSON 序列化比较(与 B4
 * prefix-stability.test.ts 同形态)。
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
// 基础 env / client 替身
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

/** 一个 connect 等到外部 release 才成功的 client(场景 a 窗口控制)。 */
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

/** 一个 connect 永不 resolve 的 client(场景 a 超时分支)。 */
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
// 断言② 双面断言 helpers
// ---------------------------------------------------------------------------

/**
 * 元素级 tools 比较:名字数组 deep-equal + 每个 ToolDef JSON 序列化
 * deep-equal(handler 函数序列化为 undefined,两轮同形 → 等价比较仍严格)。
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

/** 一次相邻两轮断言:取 before 快照 → 场景事件 → 取 after 快照 → deep-equal。 */
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
// 临时目录 helper
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

/** chat 表面最小装配(tmp home / tmp cwd,无 MCP 配置)。 */
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

/** 写入一份 .iknow/mcp.json。 */
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
