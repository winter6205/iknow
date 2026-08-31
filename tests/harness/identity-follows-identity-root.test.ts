/**
 * T3 (plans/worktree-session-roots.md) — 项目身份跟 `projectIdentityRoot`。
 *
 * 命名注意：本文件的改绑用例里 `projectIdentityRoot === productRoot`（改绑前
 * 三者同值，宿主把启动 cwd 钉下来就是主仓），所以传参看起来像 `productRoot`
 * 仍是身份源；真正区分两者的是下方「redirected workspace root」那组
 * （review round 2 的回归档）。
 *
 * 验收（ADR-0037 §4 / 硬要求 1、2、4）:
 *  1. 改绑后（`cwd` / `workspaceRoot` = task worktree，`productRoot` = 主仓）
 *     装配仍读主仓的 `.iknow/rules`、项目 `AGENTS.md`、项目 skills;
 *     树上的同名诱饵一律不得被读。
 *  2. sandbox 允许**只读** `productRoot` 的身份路径，写仍不得进主仓。
 *  3. 裸树（无 `.iknow`、无 `AGENTS.md`）不被 seed —— 装配不往树上新建目录，
 *     缺目录视为空。
 *  4. 用户级 `~/.iknow` 仍跟 `home`，不跟两个项目根。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

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

/** 在一个根上种下完整的项目身份三件套 + 一个 skill。 */
async function plantIdentity(root: string, tag: string): Promise<void> {
  await mkdir(join(root, ".iknow", "rules"), { recursive: true });
  await mkdir(join(root, ".iknow", "skills", `${tag}-skill`), {
    recursive: true,
  });
  await writeFile(join(root, "AGENTS.md"), `${tag}-AGENTS-BODY\n`, "utf8");
  await writeFile(
    join(root, ".iknow", "rules", `${tag}-rule.md`),
    `${tag}-RULE-BODY\n`,
    "utf8"
  );
  await writeFile(
    join(root, ".iknow", "permissions.toml"),
    `# ${tag} project permissions\n`,
    "utf8"
  );
  await writeFile(
    join(root, ".iknow", "skills", `${tag}-skill`, "SKILL.md"),
    `---\nname: ${tag}-skill\ndescription: ${tag}-SKILL-DESC\n---\n\nbody\n`,
    "utf8"
  );
}

async function buildRebound(opts: {
  readonly productRoot: string;
  readonly taskRoot: string;
  readonly userHome: string;
  readonly apiKey: string;
  readonly projectIdentityRoot?: string;
  /** 主仓只读放行只在隔离武装时开（round 4），读工具用例必须真开开关。 */
  readonly isolationOn?: boolean;
}): Promise<BuiltEngine> {
  const built = await buildHarnessEngine({
    env: makeEnv(opts.apiKey),
    askUser: createNoAskUser(),
    surface: "chat",
    userHome: opts.userHome,
    // 改绑后的形态：cwd / workspaceRoot / sandboxRoot 都在 task worktree 上，
    // 只有 productRoot 留在主仓。
    cwd: opts.taskRoot,
    workspaceRoot: opts.taskRoot,
    sandboxRoot: opts.taskRoot,
    productRoot: opts.productRoot,
    // 宿主在启动时钉下的项目身份根（cli / tui 都传启动 cwd）。改绑只覆盖
    // cwd / workspaceRoot，本字段不动 —— 身份因此仍指主仓。
    ...(opts.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: opts.projectIdentityRoot }
      : {}),
    // 生产里改绑只可能发生在隔离开的会话上，所以「已改绑」形态的用例把开关
    // 真的武装起来（host 缝 + settings 同时在场才算 ON，与 build-engine 的
    // isolationEnabled 同源）。
    ...(opts.isolationOn
      ? {
          settings: {
            isolation: { worktreeOnMutate: true },
          } as unknown as IknowSettings,
          worktreeIsolation: {
            provision: async ({ root }: { readonly root: string }) => root,
          },
        }
      : {}),
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

describe("project identity follows the pinned identity root after rebind (T3)", () => {
  it("reads rules / AGENTS.md / skills from the main repo, never from the tree", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-main-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "iknow-t3-tree-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-home-"));
    roots.push(productRoot, taskRoot, userHome);

    await plantIdentity(productRoot, "MAIN");
    // 诱饵：树上放一整套同形身份文件，一个都不许被读。
    await plantIdentity(taskRoot, "TREE");

    const built = await buildRebound({
      productRoot,
      taskRoot,
      projectIdentityRoot: productRoot,
      userHome,
      apiKey: "sk-test-t3-identity-1",
    });

    const prompt = (await built.deps.system?.()) ?? "";

    expect(prompt).toContain("MAIN-AGENTS-BODY");
    expect(prompt).toContain("MAIN-SKILL-DESC");
    expect(prompt).toContain(join(productRoot, ".iknow", "rules"));

    expect(prompt).not.toContain("TREE-AGENTS-BODY");
    expect(prompt).not.toContain("TREE-SKILL-DESC");
    expect(prompt).not.toContain(join(taskRoot, ".iknow", "rules"));
  });

  it("lets tools read the productRoot identity paths but never write into the main repo", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-read-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-read-home-"));
    roots.push(productRoot, userHome);
    // 真实改绑形态：树是 `<main>/.iknow/worktrees/<conv>`。主仓只读放行只在
    // 已改绑时打开（review round 3：未改绑时读沙箱必须与今日一致），所以这条
    // 用例的树必须是真形状，不能是任意 tmp 目录。
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-read");
    await mkdir(taskRoot, { recursive: true });

    await plantIdentity(productRoot, "MAIN");

    const built = await buildRebound({
      productRoot,
      taskRoot,
      projectIdentityRoot: productRoot,
      userHome,
      apiKey: "sk-test-t3-identity-2",
      isolationOn: true,
    });

    const readFile = built.deps.registry.get("read_file");
    const writeFileTool = built.deps.registry.get("write_file");
    expect(readFile).toBeDefined();
    expect(writeFileTool).toBeDefined();
    const ctx = { signal: new AbortController().signal };

    for (const identityPath of [
      join(productRoot, "AGENTS.md"),
      join(productRoot, ".iknow", "rules", "MAIN-rule.md"),
      join(productRoot, ".iknow", "permissions.toml"),
    ]) {
      await expect(
        readFile!.handler({ path: identityPath }, ctx)
      ).resolves.toBeDefined();
    }

    // 写仍不得进主仓 —— 身份路径与非身份路径都拦。
    await expect(
      writeFileTool!.handler(
        { path: join(productRoot, "AGENTS.md"), content: "hijacked" },
        ctx
      )
    ).rejects.toThrow();
    await expect(
      writeFileTool!.handler(
        { path: join(productRoot, "new-file.txt"), content: "hijacked" },
        ctx
      )
    ).rejects.toThrow();
  });

  it("does not seed .iknow onto a naked task worktree", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-naked-main-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "iknow-t3-naked-tree-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-naked-home-"));
    roots.push(productRoot, taskRoot, userHome);

    await plantIdentity(productRoot, "MAIN");

    const built = await buildRebound({
      productRoot,
      taskRoot,
      projectIdentityRoot: productRoot,
      userHome,
      apiKey: "sk-test-t3-identity-3",
    });
    const prompt = (await built.deps.system?.()) ?? "";

    expect(prompt).toContain("MAIN-AGENTS-BODY");
    expect(existsSync(join(taskRoot, ".iknow", "rules"))).toBe(false);
    expect(existsSync(join(taskRoot, ".iknow", "skills"))).toBe(false);
    expect(existsSync(join(taskRoot, "AGENTS.md"))).toBe(false);
  });

  it("keeps the user layer on home, not on either project root", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-user-main-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "iknow-t3-user-tree-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-user-home-"));
    roots.push(productRoot, taskRoot, userHome);

    await plantIdentity(productRoot, "MAIN");
    await mkdir(join(userHome, ".iknow"), { recursive: true });
    await writeFile(
      join(userHome, ".iknow", "AGENTS.md"),
      "USER-AGENTS-BODY\n",
      "utf8"
    );

    const built = await buildRebound({
      productRoot,
      taskRoot,
      projectIdentityRoot: productRoot,
      userHome,
      apiKey: "sk-test-t3-identity-4",
    });
    const prompt = (await built.deps.system?.()) ?? "";

    expect(prompt).toContain("USER-AGENTS-BODY");
    expect(prompt).toContain("MAIN-AGENTS-BODY");
    // 用户层留在 home，不被复制到任一项目根。（树上的 `.iknow/memory` 是
    // per-root 状态，由 T4 迁回 productRoot —— 这里只钉身份层。）
    expect(existsSync(join(taskRoot, ".iknow", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(productRoot, ".iknow", "AGENTS.md"))).toBe(false);
  });
});

/**
 * Review round-2 回归档：身份根**不是** `productRoot`。宿主按 ADR-0019 把
 * `productRoot` 取自 `workspaceRoot`，而 `--workspace-root <dir>` 重定向档下
 * `<dir>` 不是项目本身（`dir ≠ cwd`）—— 拿它查身份会让项目自己的 AGENTS.md /
 * rules / skills 静默消失。此档与 isolation 开关无关，OFF 时同样发生，所以由
 * 硬要求 5「OFF 与今日一致」直接管。
 */
describe("project identity stays on the project, not on a redirected workspace root", () => {
  it("reads the project's own AGENTS.md / rules / skills when workspaceRoot is redirected away from cwd", async () => {
    const anchor = await mkdtemp(join(tmpdir(), "iknow-t3-redirect-anchor-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-redirect-home-"));
    roots.push(anchor, userHome);
    const project = join(anchor, "the-project");
    await mkdir(project, { recursive: true });

    await plantIdentity(project, "PROJECT");
    // 诱饵：重定向锚上放一整套同形身份文件，一个都不许被读。
    await plantIdentity(anchor, "ANCHOR");

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t3-redirect-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      // `iknow --workspace-root <anchor>`，进程 cwd 在项目里。
      cwd: project,
      workspaceRoot: anchor,
      productRoot: anchor,
      projectIdentityRoot: project,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const prompt = (await built.deps.system?.()) ?? "";

    expect(prompt).toContain("PROJECT-AGENTS-BODY");
    expect(prompt).toContain("PROJECT-SKILL-DESC");
    expect(prompt).toContain(join(project, ".iknow", "rules"));

    expect(prompt).not.toContain("ANCHOR-AGENTS-BODY");
    expect(prompt).not.toContain("ANCHOR-SKILL-DESC");
  });

  it("does not widen the read sandbox when the session has not rebound", async () => {
    // 硬要求 5：未改绑时读沙箱与今日逐字节一致。身份根可以落在 sandbox 之外
    // （`--workspace-root <anchor>` + 项目在别处），但那不该让 read_file 够到
    // 它 —— 主仓只读放行是改绑档的补偿，不是无条件放行。
    const anchor = await mkdtemp(join(tmpdir(), "iknow-t3-off-anchor-"));
    const project = await mkdtemp(join(tmpdir(), "iknow-t3-off-project-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-off-home-"));
    roots.push(anchor, project, userHome);

    await plantIdentity(project, "PROJECT");

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t3-off-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      cwd: project,
      workspaceRoot: anchor,
      productRoot: anchor,
      projectIdentityRoot: project,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // 身份仍从项目读到（装配层不受沙箱影响）。
    expect((await built.deps.system?.()) ?? "").toContain(
      "PROJECT-AGENTS-BODY"
    );
    // 但工具够不到它 —— 与改动前同一个拒绝。
    const readFile = built.deps.registry.get("read_file");
    await expect(
      readFile!.handler(
        { path: join(project, "AGENTS.md") },
        { signal: new AbortController().signal }
      )
    ).rejects.toThrow(/outside workspace/);
  });

  it("keeps the read sandbox shut on a worktree-shaped cwd while isolation is off", async () => {
    // round 4：门不能只看路径形状。`taskWorktreeOwnerOf` 是纯字符串判断，一个
    // 恰好长成 `<X>/.iknow/worktrees/<name>` 的 cwd 在隔离关闭时同样命中 ——
    // 而这条放行本身是隔离档的补偿，OFF 档「今日」是一条都不给。
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-shape-main-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-shape-home-"));
    roots.push(productRoot, userHome);

    await plantIdentity(productRoot, "MAIN");
    await writeFile(
      join(productRoot, "SECRET-OUTSIDE.md"),
      "OUTSIDE-BODY\n",
      "utf8"
    );
    const shaped = join(productRoot, ".iknow", "worktrees", "conv-shaped");
    await mkdir(shaped, { recursive: true });

    // 隔离**没开**（不传 host 缝 / settings），其余与改绑档一模一样。
    const built = await buildRebound({
      productRoot,
      taskRoot: shaped,
      projectIdentityRoot: productRoot,
      userHome,
      apiKey: "sk-test-t3-shape-1",
    });

    const readFile = built.deps.registry.get("read_file");
    for (const outside of [
      join(productRoot, "SECRET-OUTSIDE.md"),
      join(productRoot, "AGENTS.md"),
    ]) {
      await expect(
        readFile!.handler(
          { path: outside },
          { signal: new AbortController().signal }
        )
      ).rejects.toThrow(/outside workspace/);
    }
  });

  it("falls back to the main checkout of a task-worktree-shaped cwd when a host forgets to pin the identity root", async () => {
    const productRoot = await mkdtemp(
      join(tmpdir(), "iknow-t3-fallback-main-")
    );
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-fallback-home-"));
    roots.push(productRoot, userHome);
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-fb");
    await mkdir(taskRoot, { recursive: true });

    await plantIdentity(productRoot, "MAIN");

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t3-fallback-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      // 漏钉身份根的宿主：cwd / workspaceRoot 都已切到树上。
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      sandboxRoot: taskRoot,
      productRoot,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const prompt = (await built.deps.system?.()) ?? "";

    // 退到主 checkout，而不是从空树上读出「没有身份」。
    expect(prompt).toContain("MAIN-AGENTS-BODY");
    expect(prompt).toContain(join(productRoot, ".iknow", "rules"));
  });

  it("normalizes a pinned identity root that is itself a leftover task worktree", async () => {
    // round 4：宿主钉的是启动 cwd，而 exit 后树保留不删（ADR-0037 §4），所以
    // 操作员完全可能在一棵遗留树里起 chat。只归一化 fallback 会让「钉了」比
    // 「没钉」更差 —— 钉住空树 = 项目说明书 / rules / skills 全部消失。
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-t3-pinned-tree-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-t3-pinned-home-"));
    roots.push(productRoot, userHome);
    const leftover = join(productRoot, ".iknow", "worktrees", "conv-left");
    await mkdir(leftover, { recursive: true });

    await plantIdentity(productRoot, "MAIN");

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t3-pinned-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      // 宿主在遗留树里启动，于是把树本身钉成了身份根。
      cwd: leftover,
      workspaceRoot: leftover,
      sandboxRoot: leftover,
      productRoot,
      projectIdentityRoot: leftover,
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    expect(built.sessionRoots?.projectIdentityRoot).toBe(productRoot);
    const prompt = (await built.deps.system?.()) ?? "";
    expect(prompt).toContain("MAIN-AGENTS-BODY");
    expect(prompt).toContain(join(productRoot, ".iknow", "rules"));
  });
});
