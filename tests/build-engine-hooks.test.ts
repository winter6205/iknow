/**
 * #365 T1 tests: build-engine hooks 透传观测缝。
 *
 * 验证 `BuildEngineOpts.hooks` (单个 `PostToolUseHook` 函数) 被包装成
 * `createAciExecutor` 的 `hooks: { postToolUse }` 形态并在 executor 层触发:
 * 真实调用一次 read_file 工具后,stub hook 收到含 toolUseId / name / kind 的参数。
 * 同时验证不传 hooks 时装配照常(chat/serve 零变化)。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import type { PostToolUseHook } from "../src/harness/permission/types.ts";
import type { IknowEnv } from "../src/config/env.ts";

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string | undefined): IknowEnv {
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
    // #119 T7: IknowCompressEnv 必填(T1 接入),build-engine 透传。test fixture
    // 默认 contextWindow=200000, thresholdTokens=undefined(由 threshold.ts 推)。
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

describe("buildHarnessEngine — #365 T1 hooks 透传观测缝", () => {
  it("hooks 透传进 createAciExecutor:executor 调用后 stub postToolUse 被触发", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-hooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello hooks\n", "utf8");

    // stub hook:push 每次调用参数,断言透传形态。
    const calls: Array<Parameters<PostToolUseHook>[0]> = [];
    const hooks: PostToolUseHook = (result) => {
      calls.push(result);
    };

    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t1-hooks-1"),
        askUser: createNoAskUser(),
        cwd: root,
        workspaceRoot: root,
        productRoot: root,
        sandboxRoot: root,
        hooks,
        // 本文件验 hooks 透传,不验溢出退场 / 索引降档(专测见
        // build-engine-tool-overflow.test.ts、disclosure-index-align/)。
        // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
        skipCountTokens: true,
      });

      // createAciExecutor 返回 Executor 类型(executeAll 是函数)。
      expect(built.deps.executor).toBeDefined();
      expect(typeof built.deps.executor.executeAll).toBe("function");

      // 真实调用 read_file(读沙箱根内文件 → ok),postToolUse 在 step5 触发。
      const [result] = await built.deps.executor.executeAll([
        {
          id: "hook-read",
          name: "read_file",
          input: { path: filePath },
        },
      ]);
      expect(result.kind).toBe("ok");

      // 关键断言:hook 被调用且参数含 toolUseId / name / kind。
      expect(calls.length).toBeGreaterThan(0);
      const hookCall = calls[0];
      expect(hookCall.toolUseId).toBe("hook-read");
      expect(hookCall.name).toBe("read_file");
      expect(hookCall.kind).toBe("ok");

      // cleanup:MCP + subagent 组合 shutdown(空 config,不抛)。
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("不传 hooks → 装配照常,executor 可调用(chat/serve 零变化)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-nohooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "no hooks\n", "utf8");

    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t1-nohooks-1"),
        askUser: createNoAskUser(),
        cwd: root,
        workspaceRoot: root,
        productRoot: root,
        sandboxRoot: root,
        skipCountTokens: true, // 同上:验不传 hooks 时装配照常。
      });

      expect(typeof built.deps.executor.executeAll).toBe("function");
      const [result] = await built.deps.executor.executeAll([
        { id: "nohooks-read", name: "read_file", input: { path: filePath } },
      ]);
      expect(result.kind).toBe("ok");

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
