/**
 * T4 (plans/worktree-session-roots.md) — per-root 状态留在 `productRoot`。
 *
 * 验收（ADR-0037 §4 / §5）:
 *  1. 改绑后（`cwd` / `workspaceRoot` = task worktree，`productRoot` = 主仓）
 *     记忆库目录与 tasks 登记仍落 `productRoot/.iknow/...`，且与**改绑前**
 *     同一路径（命名空间 hash 不因 cwd 换成树而漂移）。
 *  2. 不在 task 树下新建另一份 memory / tasks。
 *  3. 启动注入的 settings 对象不因 cwd 换成树而重读空文件（§5：改绑不隐式
 *     重载 settings）。
 *
 * 注：sandbox 的 `workspaceRoot`（fs-policy 保护路径 + fence bind root）**不**
 * 迁到 productRoot —— task worktree 位于 `<productRoot>/.iknow/worktrees/…`
 * 之下，若把 `<productRoot>/.iknow` 设为保护路径，树内所有写都会被自己拦住。
 * 写与 fence 跟 `taskRoot`，本文件最后一例钉住这条边界。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tasksDir 是装配期一次性传给 background manager 的构造参数，没有句柄透出，
// 因此用与 build-engine-subagent-spawn-root.test.ts 同款的 vi.hoisted 捕获。
const mockState = vi.hoisted(() => ({
  tasksDirs: [] as unknown[],
}));

vi.mock("../../src/harness/background/manager.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/harness/background/manager.ts")
    >();
  return {
    ...actual,
    createBackgroundTaskManager: vi.fn(
      (opts: { readonly tasksDir?: string }) => {
        mockState.tasksDirs.push(opts.tasksDir);
        return actual.createBackgroundTaskManager(
          opts as Parameters<typeof actual.createBackgroundTaskManager>[0]
        );
      }
    ),
  };
});

const { buildHarnessEngine } =
  await import("../../src/harness/build-engine.ts");
type BuiltEngine = Awaited<ReturnType<typeof buildHarnessEngine>>;
const { createNoAskUser } =
  await import("../../src/harness/permission/ask-user.ts");
const { resolveProjectMemoryDir } =
  await import("../../src/harness/memory/paths.ts");
type IknowEnv = import("../../src/config/env.ts").IknowEnv;

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
  mockState.tasksDirs.length = 0;
});

/**
 * 造一对根：主仓 + 它自己 `.iknow/worktrees/<conv>` 下的 task worktree
 * （真实形状 —— 树是主仓 `.iknow` 的后代，这一点对 fence 边界那条用例是必要的）。
 */
async function makeRoots(tag: string): Promise<{
  readonly productRoot: string;
  readonly taskRoot: string;
  readonly userHome: string;
}> {
  const productRoot = await mkdtemp(join(tmpdir(), `iknow-t4-${tag}-main-`));
  const userHome = await mkdtemp(join(tmpdir(), `iknow-t4-${tag}-home-`));
  const taskRoot = join(productRoot, ".iknow", "worktrees", `conv-${tag}`);
  await mkdir(taskRoot, { recursive: true });
  roots.push(productRoot, userHome);
  return { productRoot, taskRoot, userHome };
}

async function build(opts: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly productRoot: string;
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
    sandboxRoot: opts.workspaceRoot,
    productRoot: opts.productRoot,
  });
  shutdowns.push(async () => {
    if (built.shutdown) await built.shutdown();
  });
  return built;
}

/** 走真工具写一条记忆，返回落盘文件所在目录树的实际内容。 */
async function saveMemory(built: BuiltEngine, title: string): Promise<void> {
  const tool = built.deps.registry.get("memory_save");
  expect(tool).toBeDefined();
  await tool!.handler(
    { title, body: `${title} — body`, type: "fact" },
    { signal: new AbortController().signal }
  );
}

describe("per-root state stays on productRoot after rebind (T4)", () => {
  it("writes memory into productRoot/.iknow/memory — same path as before the rebind", async () => {
    const { productRoot, taskRoot, userHome } = await makeRoots("mem");

    // 改绑前：三根同值（未绑定会话的今日形态）。
    const before = await build({
      cwd: productRoot,
      workspaceRoot: productRoot,
      productRoot,
      userHome,
      apiKey: "sk-test-t4-mem-1",
    });
    await saveMemory(before, "memory written before the rebind");
    const memoryRoot = join(productRoot, ".iknow", "memory");
    const namespacesBefore = await readdir(memoryRoot);
    expect(namespacesBefore).toHaveLength(1);

    // 改绑后：cwd / workspaceRoot 切到树上，只有 productRoot 留在主仓。
    const after = await build({
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      productRoot,
      userHome,
      apiKey: "sk-test-t4-mem-2",
    });
    await saveMemory(after, "memory written after the rebind");

    // 同一个命名空间目录 —— 不是主仓下的第二个 namespace，也不是树上的新库。
    expect(await readdir(memoryRoot)).toEqual(namespacesBefore);
    expect(existsSync(join(taskRoot, ".iknow", "memory"))).toBe(false);

    // 路径 SSOT：命名空间锚 = productRoot，与 cwd 无关。
    expect(join(memoryRoot, namespacesBefore[0]!)).toBe(
      resolveProjectMemoryDir(productRoot, productRoot)
    );
  });

  it("registers background tasks under productRoot/.iknow/tasks, not under the tree", async () => {
    const { productRoot, taskRoot, userHome } = await makeRoots("tasks");

    await build({
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      productRoot,
      userHome,
      apiKey: "sk-test-t4-tasks-1",
    });

    expect(mockState.tasksDirs).toEqual([join(productRoot, ".iknow", "tasks")]);
    expect(existsSync(join(taskRoot, ".iknow", "tasks"))).toBe(false);
  });

  it("reuses the startup settings object instead of re-reading the tree's missing settings.json", async () => {
    const { productRoot, taskRoot, userHome } = await makeRoots("settings");
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "settings.json"),
      JSON.stringify({ memory: { autoExtract: true } }),
      "utf8"
    );

    // 宿主把启动时读到的 settings 对象注入（hub / TUI 的既有形态）。
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t4-settings-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      sandboxRoot: taskRoot,
      productRoot,
      settings: { memory: { autoExtract: true } },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // autoExtract=true 的可观测后果：auto-memory 钩子在场。若装配改从树上
    // 重读 settings（树内 `.iknow` 不存在 → 空对象），钩子会静默缺席。
    expect(built.autoMemory).toBeDefined();
    expect(existsSync(join(taskRoot, ".iknow", "settings.json"))).toBe(false);
  });

  it("keeps the sandbox fence on taskRoot so writes inside the tree are not self-blocked", async () => {
    const { productRoot, taskRoot, userHome } = await makeRoots("fence");

    const built = await build({
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      productRoot,
      userHome,
      apiKey: "sk-test-t4-fence-1",
    });

    const writeFileTool = built.deps.registry.get("write_file");
    expect(writeFileTool).toBeDefined();
    const ctx = { signal: new AbortController().signal };

    // 树内普通写必须放行 —— 树本身位于 `<productRoot>/.iknow/worktrees/…`
    // 之下，保护路径若跟 productRoot 走，这一写会被自己的状态围栏拦死。
    await expect(
      writeFileTool!.handler(
        { path: join(taskRoot, "src", "feature.ts"), content: "export {};\n" },
        ctx
      )
    ).resolves.toBeDefined();

    // 主仓状态仍不可写。
    await expect(
      writeFileTool!.handler(
        {
          path: join(productRoot, ".iknow", "settings.json"),
          content: "{}",
        },
        ctx
      )
    ).rejects.toThrow();
  });
});
