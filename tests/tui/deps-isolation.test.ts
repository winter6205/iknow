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

  test("开关 ON + provision 缝：首个 mutate 被门禁拦截且 provision 收到会话锚", async () => {
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
        provision: async ({ conversationId, root: sessionRoot }) => {
          calls.push({ conversationId, root: sessionRoot });
          // 模拟 rebind：返回与引擎根不同的 task worktree 路径 → 拦截
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
    expect(calls).toEqual([{ conversationId: "conv-1", root }]);
    // 主仓零写入（门禁拦截在工具执行前）
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
});
