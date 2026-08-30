/**
 * tests/tui/deps-isolation.test.ts
 *
 * Review High-1 / High-2 (2026-08-29, plans/worktree-isolation-on-mutate.md):
 * TUI 入口（buildTuiDeps → buildHarnessEngine）必须与 serve hub 的两条装配
 * 路径行为一致：
 *   - High-1: opts.worktreeIsolation（host provision 缝）透传到 build-engine
 *     → 开关 ON 时 mutate 被门禁拦截（首个 mutate 不落主仓），不再是「TUI
 *     入口零拦截直写」。
 *   - High-2: opts.settings（启动装配的 IknowSettings 对象）透传 → 开关读取
 *     用启动装配结果；rebind 后 per-root 重建的引擎复用同一对象（run.tsx 的
 *     buildEngine 缝复用同一 depsOpts），worktree 内 `.iknow/` 缺席也绝不
 *     隐式重载 settings（硬要求 9）。
 * bun:test（tests/tui 由 bun 驱动，D2 裁决）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";
import type { IknowSettings } from "../../src/config/settings.js";

/** 最小合法 RuntimeBundle（与 deps-tools.test.ts 同形；只读 env 字段）。 */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui",
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
  return { env } as unknown as RuntimeBundle;
}

const writeCall = {
  id: "mutate-1",
  name: "write_file",
  input: { path: "hello.txt", content: "never lands while gated" },
};

describe("buildTuiDeps — worktree isolation host seam (review High-1)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("开关 ON + 未改绑主仓：首个 mutate 被门禁拦截，provision 缝不被调用（不自动建树），文案指向建树 ACI 工具", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-iso-on-"));
    roots.push(root);
    const calls: Array<{ conversationId?: string; root: string }> = [];
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      // High-2：启动装配的 settings 对象（isolation ON）注入
      settings: { isolation: { worktreeOnMutate: true } } as IknowSettings,
      worktreeIsolation: {
        // T3 model-provision 合同：主仓根上的被拦 mutate 绝不触发 provision
        // （建树改由模型调用 create-task-worktree ACI 工具，T4）
        provision: async ({ conversationId, root: sessionRoot }) => {
          calls.push({ conversationId, root: sessionRoot });
          return join(sessionRoot, ".iknow", "worktrees", conversationId ?? "x");
        },
      },
    });

    const [result] = await deps.executor.executeAll(
      [writeCall],
      undefined,
      undefined,
      "conv-1"
    );

    expect(result.kind).toBe("execution_failed");
    expect(result.message).toContain("[worktree_isolation]");
    expect(result.message).toContain("create-task-worktree ACI tool");
    expect(result.message).not.toContain("end the turn");
    // 执行路径上零 provision / 零 git 调用 → 主仓零写入
    expect(calls).toEqual([]);
    expect(await Bun.file(join(root, "hello.txt")).exists()).toBe(false);
  });

  test("开关 OFF（settings 缺 isolation）：provision 缝在场也不拦截（默认关闭零变化）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-iso-off-"));
    roots.push(root);
    let provisionCalls = 0;
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      worktreeIsolation: {
        provision: async () => {
          provisionCalls += 1;
          return root;
        },
      },
    });

    const [result] = await deps.executor.executeAll(
      [writeCall],
      undefined,
      undefined,
      "conv-1"
    );

    expect(provisionCalls).toBe(0);
    expect(result.message ?? "").not.toContain("[worktree_isolation]");
  });

  test("T7/T8：TUI 只接 provision 缝（worktreeEnter / worktreeExit 缺席）→ 两个 enter/exit 工具名不入注册表", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-iso-surface-"));
    roots.push(root);
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      settings: { isolation: { worktreeOnMutate: true } } as IknowSettings,
      worktreeIsolation: {
        provision: async ({ conversationId, root: sessionRoot }) =>
          join(sessionRoot, ".iknow", "worktrees", conversationId ?? "x"),
      },
    });

    const names = deps.registry.list().map((d) => d.name);
    expect(names).not.toContain("enter-task-worktree");
    expect(names).not.toContain("exit-task-worktree");
  });
});

describe("buildTuiDeps — T6 productRoot passthrough (worktree-mcp-rebind-lifecycle)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("opts.productRoot 透传到 buildHarnessEngine；rebuild 形态保留 productRoot", async () => {
    const { readFileSync } = await import("node:fs");
    const depsSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "tui", "deps.ts"),
      "utf8"
    );
    expect(depsSrc).toMatch(/readonly productRoot\?:\s*string/);
    expect(depsSrc).toMatch(/opts\.productRoot/);
    // reload 不得再用裸 cwd 当 mcpConfigRoot
    const reloadIdx = depsSrc.indexOf("const reload");
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    const reloadBlock = depsSrc.slice(reloadIdx, reloadIdx + 400);
    expect(reloadBlock).toMatch(/mcpConfigRoot/);
    expect(reloadBlock).not.toMatch(/mcpConfigRoot:\s*cwd\b/);
  });
});
