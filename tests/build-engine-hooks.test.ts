/**
 * Observability seam for build-engine hooks pass-through.
 *
 * Verifies `BuildEngineOpts.hooks` (a single `PostToolUseHook` function) is
 * wrapped into the `hooks: { postToolUse }` shape consumed by
 * `createAciExecutor` and fires at executor level: after one real read_file
 * call, the stub hook receives args containing toolUseId / name / kind.
 * Also verifies wiring still works without hooks (chat/serve unaffected).
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
    // IknowCompressEnv is required (build-engine passes it through).
    // Test fixture defaults: contextWindow=200000, thresholdTokens=undefined
    // (derived by threshold.ts).
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // MCP connection timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    // ADR-0019 roots: unset in these tests, so the resolver falls back to cwd.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

describe("buildHarnessEngine — #365 T1 hooks 透传观测缝", () => {
  it("hooks 透传进 createAciExecutor:executor 调用后 stub postToolUse 被触发", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t1-hooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello hooks\n", "utf8");

    // stub hook: records call args so we can assert the pass-through shape.
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
        // This file only covers hooks pass-through, not overflow eviction or
        // index downgrade (see build-engine-tool-overflow.test.ts and
        // disclosure-index-align/). countTokens is bypassed during wiring;
        // semantics of the seam are documented on BuildEngineOpts.skipCountTokens.
        skipCountTokens: true,
      });

      // createAciExecutor returns an Executor (executeAll is a function).
      expect(built.deps.executor).toBeDefined();
      expect(typeof built.deps.executor.executeAll).toBe("function");

      // Real read_file call on a file inside the sandbox root -> ok; postToolUse fires at step5.
      const [result] = await built.deps.executor.executeAll([
        {
          id: "hook-read",
          name: "read_file",
          input: { path: filePath },
        },
      ]);
      expect(result.kind).toBe("ok");

      // Key assertion: hook fired with toolUseId / name / kind present.
      expect(calls.length).toBeGreaterThan(0);
      const hookCall = calls[0];
      expect(hookCall.toolUseId).toBe("hook-read");
      expect(hookCall.name).toBe("read_file");
      expect(hookCall.kind).toBe("ok");

      // cleanup: combined MCP + subagent shutdown (empty config, must not throw).
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
        skipCountTokens: true, // same as above: wiring must work without hooks.
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
