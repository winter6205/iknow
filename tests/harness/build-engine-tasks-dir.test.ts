/**
 * ADR-0088 (docs/adr/0088-home-project-tree.md) — the background-task
 * registry root shares the home-side project tree with the session pool:
 * `<poolRoot>/projects/<slug>/tasks/` (`poolRoot` = explicit dataDir else
 * `~/.iknow`; `slug` = ADR-0071's `basename(projectIdentityRoot)-sha1[:12]`).
 *
 * This file pins three assembly-layer invariants (unit-testing
 * `resolveTasksDir` proves the formula but not the wiring):
 *   1. default pool root = `<userHome>/.iknow` (`resolveServeDataDir()`'s default);
 *   2. the slug comes from `projectIdentityRoot`, NOT from cwd / workspaceRoot;
 *   3. changing workspaceRoot does not change the tasks path (a throwaway
 *      checkout opens no separate live ledger — the ADR-0021 D1.3 form
 *      `<workspaceRoot>/.iknow/tasks` is retired).
 *
 * Technique: module-mock `createBackgroundTaskManager` to capture
 * `opts.tasksDir` (delegating to the real factory, so behavior is unchanged);
 * the rest of the assembly runs for real.
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

/** Expected value using the exact same formula as `resolveProjectSessionDir`:
 *  a cross-function equality (do NOT recompute the hash independently in the
 *  test — that would keep both sides "green" even after the formula drifts). */
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
    // This file verifies tasksDir wiring only, not tool overflow / index
    // demotion or real MCP connections.
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
    // The old form (ADR-0021 D1.3) is retired: workspace `.iknow/tasks` is no longer a write target.
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
