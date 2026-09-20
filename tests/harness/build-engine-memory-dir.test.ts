/**
 * ADR-0099 — the project memory store lives in the same home-side project
 * tree as the session pool: `<poolRoot>/projects/<slug>/memory/`.
 *
 * Technique mirrors build-engine-tasks-dir.test.ts: module-mock
 * `createSystemResolver` to capture `ctx.memoryDir`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ memoryDirs: [] as string[] }));

vi.mock("../../src/harness/memory/refresh.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/memory/refresh.js")
    >();
  return {
    ...actual,
    createSystemResolver: (ctx: { memoryDir: string }, opts?: unknown) => {
      captured.memoryDirs.push(ctx.memoryDir);
      return actual.createSystemResolver(
        ctx as Parameters<typeof actual.createSystemResolver>[0],
        opts as Parameters<typeof actual.createSystemResolver>[1]
      );
    },
  };
});

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
import type { IknowEnv } from "../../src/config/env.js";

function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-memory-dir",
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

function expectedMemoryDir(
  poolRoot: string,
  projectIdentityRoot: string
): string {
  return join(
    resolveProjectSessionDir(poolRoot, projectIdentityRoot),
    "memory"
  );
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

async function build(opts: {
  readonly userHome: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly projectIdentityRoot?: string;
  readonly memoryDir?: string;
}): Promise<BuiltEngine> {
  const built = await buildHarnessEngine({
    env: makeEnv(),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: opts.userHome,
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    productRoot: opts.workspaceRoot,
    ...(opts.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: opts.projectIdentityRoot }
      : {}),
    ...(opts.memoryDir !== undefined ? { memoryDir: opts.memoryDir } : {}),
    skipCountTokens: true,
    mcpFirstTurnReadyTimeoutMs: 150,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("buildHarnessEngine — memoryDir 锚 home 项目树 (ADR-0099)", () => {
  it("缺省池根 = <userHome>/.iknow,slug 跟 projectIdentityRoot", async () => {
    captured.memoryDirs.length = 0;
    const userHome = await makeTmp("iknow-mem-home-");
    const projectRoot = await makeTmp("iknow-mem-proj-");
    await build({ userHome, cwd: projectRoot, workspaceRoot: projectRoot });

    expect(captured.memoryDirs).toEqual([
      expectedMemoryDir(join(userHome, ".iknow"), projectRoot),
    ]);
    expect(captured.memoryDirs[0].startsWith(join(projectRoot, ".iknow"))).toBe(
      false
    );
  });

  it("换 workspaceRoot 不改 memory 路径(throwaway 不另开记忆库)", async () => {
    captured.memoryDirs.length = 0;
    const userHome = await makeTmp("iknow-mem-home-same-");
    const projectRoot = await makeTmp("iknow-mem-proj-same-");
    const wsA = await makeTmp("iknow-mem-ws-a-");
    const wsB = await makeTmp("iknow-mem-ws-b-");
    await build({
      userHome,
      cwd: projectRoot,
      workspaceRoot: wsA,
      projectIdentityRoot: projectRoot,
    });
    await build({
      userHome,
      cwd: projectRoot,
      workspaceRoot: wsB,
      projectIdentityRoot: projectRoot,
    });

    expect(captured.memoryDirs).toHaveLength(2);
    expect(captured.memoryDirs[0]).toBe(captured.memoryDirs[1]);
    expect(captured.memoryDirs[0]).toBe(
      expectedMemoryDir(join(userHome, ".iknow"), projectRoot)
    );
  });

  it("host 注入 memoryDir 优先", async () => {
    captured.memoryDirs.length = 0;
    const userHome = await makeTmp("iknow-mem-home-host-");
    const projectRoot = await makeTmp("iknow-mem-proj-host-");
    const injected = await makeTmp("iknow-mem-injected-");
    await build({
      userHome,
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      memoryDir: join(injected, "memory"),
    });

    expect(captured.memoryDirs).toEqual([join(injected, "memory")]);
  });
});
