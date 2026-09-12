/**
 * ADR-0088 (docs/adr/0088-home-project-tree.md) — 后台任务登记根跟会话池同一
 * 项目树:`<poolRoot>/projects/<slug>/tasks/`(`poolRoot` = 显式 dataDir 否则
 * `~/.iknow`,`slug` = ADR-0071 的 `basename(projectIdentityRoot)-sha1[:12]`)。
 *
 * 本文件钉三条装配层不变式(单测 `resolveTasksDir` 只证公式,证不了接线):
 *   1. 缺省池根 = `<userHome>/.iknow`(`resolveServeDataDir()` 的默认);
 *   2. slug 取自 `projectIdentityRoot`,**不**取自 cwd / workspaceRoot;
 *   3. 换 workspaceRoot 不改 tasks 路径(throwaway checkout 不另开活账本,
 *      即 ADR-0021 D1.3 的 `<workspaceRoot>/.iknow/tasks` 形态已退役)。
 *
 * 手法与 `build-engine-install-root.test.ts` 同款:module-mock
 * `createBackgroundTaskManager` 抓 `opts.tasksDir`(委托真实工厂,行为不变),
 * 其余装配走真实路径。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ tasksDirs: [] as string[] }));

vi.mock("../../src/harness/background/manager.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/background/manager.js")
    >();
  return {
    ...actual,
    createBackgroundTaskManager: (opts: { tasksDir: string }) => {
      captured.tasksDirs.push(opts.tasksDir);
      return actual.createBackgroundTaskManager(opts);
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
      apiKey: "sk-test-tasks-dir",
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

/** 与 `resolveProjectSessionDir` 严格同公式的期望值:跨函数等式(不要独立重算
 *  哈希 —— review fix:测试独立重算会让公式漂移后两边仍各自"绿")。 */
function expectedTasksDir(
  poolRoot: string,
  projectIdentityRoot: string
): string {
  return join(resolveProjectSessionDir(poolRoot, projectIdentityRoot), "tasks");
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
  readonly tasksDir?: string;
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
    ...(opts.tasksDir !== undefined ? { tasksDir: opts.tasksDir } : {}),
    // 本文件只验 tasksDir 接线,不验溢出退场 / 索引降档 / 真 MCP 连接。
    skipCountTokens: true,
    mcpFirstTurnReadyTimeoutMs: 150,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("buildHarnessEngine — tasksDir 锚 home 项目树 (ADR-0088)", () => {
  it("缺省池根 = <userHome>/.iknow,slug 跟 projectIdentityRoot", async () => {
    captured.tasksDirs.length = 0;
    const userHome = await makeTmp("iknow-t8-home-");
    const projectRoot = await makeTmp("iknow-t8-proj-");
    await build({ userHome, cwd: projectRoot, workspaceRoot: projectRoot });

    expect(captured.tasksDirs).toEqual([
      expectedTasksDir(join(userHome, ".iknow"), projectRoot),
    ]);
    // 旧形态(ADR-0021 D1.3)已退役:工作区 `.iknow/tasks` 不再是写点。
    expect(captured.tasksDirs[0].startsWith(join(projectRoot, ".iknow"))).toBe(
      false
    );
  });

  it("换 workspaceRoot 不改 tasks 路径(throwaway 不另开活账本)", async () => {
    captured.tasksDirs.length = 0;
    const userHome = await makeTmp("iknow-t8-home-same-");
    const projectRoot = await makeTmp("iknow-t8-proj-same-");
    const wsA = await makeTmp("iknow-t8-ws-a-");
    const wsB = await makeTmp("iknow-t8-ws-b-");
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

    expect(captured.tasksDirs).toHaveLength(2);
    expect(captured.tasksDirs[0]).toBe(captured.tasksDirs[1]);
    expect(captured.tasksDirs[0]).toBe(
      expectedTasksDir(join(userHome, ".iknow"), projectRoot)
    );
  });

  it("host 注入 tasksDir 优先(三入口显式接线形态)", async () => {
    captured.tasksDirs.length = 0;
    const userHome = await makeTmp("iknow-t8-home-host-");
    const projectRoot = await makeTmp("iknow-t8-proj-host-");
    const injected = await makeTmp("iknow-t8-injected-");
    await build({
      userHome,
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      tasksDir: join(injected, "tasks"),
    });

    expect(captured.tasksDirs).toEqual([join(injected, "tasks")]);
  });
});
