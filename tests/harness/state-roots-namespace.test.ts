/**
 * T4 review High-1 — 记忆库的两个决策必须分开推：
 *   **落哪个根**（anchor，ADR-0019 per-root state anchor，可被
 *   `--workspace-root` 显式重定向）与 **叫什么名**（namespace，项目身份）。
 *
 * 回归来源：T4 一度把两者都设成 `productRoot`。在 ADR-0019 D1.3 的
 * `--workspace-root <dir>` 重定向档下 `productRoot` 缺省等于 `workspaceRoot`，
 * 于是同一个锚下的不同项目塌进同一个命名空间目录 —— 跨项目记忆互相污染，
 * 且老用户既有的命名空间目录（`<basename(cwd)>-<sha1(cwd)>`）变成不可达。
 *
 * 钉的是装配层实际落盘的目录（不是 paths.ts 的纯 join），因为决策在
 * build-engine：`state-follows-product-root.test.ts` 只覆盖三根同值的档，
 * `cwd ≠ workspaceRoot` 这一档此前无人守。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { resolveProjectMemoryDir } from "../../src/harness/memory/paths.ts";
import type { IknowEnv } from "../../src/config/env.ts";

type BuiltEngine = Awaited<ReturnType<typeof buildHarnessEngine>>;

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

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

async function build(opts: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly productRoot?: string;
  readonly projectIdentityRoot?: string;
  readonly userHome: string;
  readonly apiKey: string;
}): Promise<BuiltEngine> {
  const built = await buildHarnessEngine({
    env: makeEnv(opts.apiKey),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: opts.userHome,
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    ...(opts.productRoot !== undefined
      ? { productRoot: opts.productRoot }
      : {}),
    ...(opts.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: opts.projectIdentityRoot }
      : {}),
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

/** 走真工具写一条记忆，让库目录真的落盘。 */
async function saveMemory(built: BuiltEngine, title: string): Promise<void> {
  const tool = built.deps.registry.get("memory_save");
  expect(tool).toBeDefined();
  await tool!.handler(
    { title, body: `${title} — body`, type: "fact" },
    { signal: new AbortController().signal }
  );
}

/** 锚下实际出现的命名空间目录（绝对路径）。 */
async function namespacesUnder(anchor: string): Promise<readonly string[]> {
  const memoryRoot = join(anchor, ".iknow", "memory");
  if (!existsSync(memoryRoot)) return [];
  return (await readdir(memoryRoot)).sort().map((n) => join(memoryRoot, n));
}

describe("memory namespace and state anchor are separate decisions (T4 review High-1)", () => {
  it("keeps one namespace per project under a redirected anchor, byte-identical to the pre-change path", async () => {
    const anchor = await mkdtemp(join(tmpdir(), "iknow-ns-anchor-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-ns-home-"));
    roots.push(anchor, userHome);
    const projA = join(anchor, "proj-a");
    const projB = join(anchor, "proj-b");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    // `--workspace-root <anchor>` 档：cwd 是项目，锚是它的父目录。
    await saveMemory(
      await build({
        cwd: projA,
        workspaceRoot: anchor,
        userHome,
        apiKey: "sk-test-ns-1",
      }),
      "from project a"
    );
    await saveMemory(
      await build({
        cwd: projB,
        workspaceRoot: anchor,
        userHome,
        apiKey: "sk-test-ns-2",
      }),
      "from project b"
    );

    // 库仍落被重定向的锚（ADR-0019 D1.3 仍生效），且两个项目各一个命名空间。
    expect(await namespacesUnder(anchor)).toEqual(
      [
        resolveProjectMemoryDir(projA, anchor),
        resolveProjectMemoryDir(projB, anchor),
      ].sort()
    );
    // 命名空间名仍由项目 cwd 决定 —— 不是锚的 basename。
    for (const ns of await namespacesUnder(anchor)) {
      expect(basename(ns).startsWith(`${basename(anchor)}-`)).toBe(false);
    }
    expect(await namespacesUnder(projA)).toEqual([]);
  });

  it("moves the anchor off the tree after a rebind without drifting the namespace", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-ns-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-ns-rb-home-"));
    roots.push(productRoot, userHome);
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-ns");
    await mkdir(taskRoot, { recursive: true });

    await saveMemory(
      await build({
        cwd: productRoot,
        workspaceRoot: productRoot,
        productRoot,
        userHome,
        apiKey: "sk-test-ns-3",
      }),
      "before the rebind"
    );
    const before = await namespacesUnder(productRoot);
    expect(before).toHaveLength(1);

    await saveMemory(
      await build({
        cwd: taskRoot,
        workspaceRoot: taskRoot,
        productRoot,
        userHome,
        apiKey: "sk-test-ns-4",
      }),
      "after the rebind"
    );

    expect(await namespacesUnder(productRoot)).toEqual(before);
    expect(existsSync(join(taskRoot, ".iknow", "memory"))).toBe(false);
  });

  it("keeps the namespace when the startup cwd is a subdirectory of the repo and the session then rebinds", async () => {
    // 两个维度的交叉档：`cwd ≠ workspaceRoot`（启动在仓内子目录）**且**改绑。
    // 现算 `mainCheckoutOf(cwd)` 在这里会让名字从 `app-…` 跳到 `<repo>-…`，
    // 改绑前存的记忆改绑后不可见 —— 宿主钉下的启动身份挡住这次跳变。
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-ns-sub-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-ns-sub-home-"));
    roots.push(productRoot, userHome);
    const startupCwd = join(productRoot, "packages", "app");
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-sub");
    await mkdir(startupCwd, { recursive: true });
    await mkdir(taskRoot, { recursive: true });

    await saveMemory(
      await build({
        cwd: startupCwd,
        workspaceRoot: productRoot,
        productRoot,
        projectIdentityRoot: startupCwd,
        userHome,
        apiKey: "sk-test-ns-sub-1",
      }),
      "before the rebind"
    );
    const before = await namespacesUnder(productRoot);
    expect(before).toEqual([resolveProjectMemoryDir(startupCwd, productRoot)]);

    await saveMemory(
      await build({
        // 宿主改绑：cwd / workspaceRoot 切到树上，启动身份不动。
        cwd: taskRoot,
        workspaceRoot: taskRoot,
        productRoot,
        projectIdentityRoot: startupCwd,
        userHome,
        apiKey: "sk-test-ns-sub-2",
      }),
      "after the rebind"
    );

    expect(await namespacesUnder(productRoot)).toEqual(before);
    expect(existsSync(join(taskRoot, ".iknow", "memory"))).toBe(false);
  });

  it("rejects an explicit but unusable identity root instead of resolving it against the live cwd", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-ns-bad-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-ns-bad-home-"));
    roots.push(productRoot, userHome);

    for (const bad of ["", "   ", "relative/project", "./here"]) {
      await expect(
        build({
          cwd: productRoot,
          workspaceRoot: productRoot,
          productRoot,
          projectIdentityRoot: bad,
          userHome,
          apiKey: "sk-test-ns-bad",
        })
      ).rejects.toThrow(/projectIdentityRoot/);
    }
  });

  it("does not anchor state on the tree when a host forgets to pass productRoot", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-ns-fb-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-ns-fb-home-"));
    roots.push(productRoot, userHome);
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-fb");
    await mkdir(taskRoot, { recursive: true });

    // 漏接 productRoot 的宿主：cwd / workspaceRoot 都已切到树上。
    await saveMemory(
      await build({
        cwd: taskRoot,
        workspaceRoot: taskRoot,
        userHome,
        apiKey: "sk-test-ns-5",
      }),
      "host forgot productRoot"
    );

    expect(await namespacesUnder(productRoot)).toEqual([
      resolveProjectMemoryDir(productRoot, productRoot),
    ]);
    expect(existsSync(join(taskRoot, ".iknow", "memory"))).toBe(false);
  });
});
