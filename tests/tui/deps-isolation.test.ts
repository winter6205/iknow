/**
 * tests/tui/deps-isolation.test.ts
 *
 * The TUI entry (buildTuiDeps → buildHarnessEngine) must match the serve hub's
 * two assembly paths:
 *   - opts.worktreeIsolation (the host provision seam) passes through to
 *     build-engine → with the switch ON, mutate is gated (the first mutate does
 *     not land in the main repo), no longer "TUI entry writes straight through
 *     with zero gating".
 *   - opts.settings (the IknowSettings object assembled at startup) passes
 *     through → switch reads use the startup assembly result; after rebind, the
 *     per-root rebuilt engine reuses the same object (run.tsx's buildEngine seam
 *     reuses the same depsOpts), so a missing `.iknow/` inside the worktree must
 *     never implicitly reload settings.
 * bun:test (tests/tui is driven by bun).
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

/** Minimal valid RuntimeBundle (same shape as deps-tools.test.ts; reads only the env field). */
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
    // ADR-0019 root anchors: unset in the fixture (loadIknowEnv maps an empty
    // IKNOW_WORKSPACE_ROOT / IKNOW_PRODUCT_ROOT to undefined).
    workspaceRoot: undefined,
    productRoot: undefined,
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

  test("开关 ON + provision 缝：首个 mutate 被 unbound 门禁拦截且 provision 零调用（T3 model-provision 契约）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-iso-on-"));
    roots.push(root);
    const calls: Array<{ conversationId?: string; root: string }> = [];
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      // settings object assembled at startup (isolation ON) injected
      settings: { isolation: { worktreeOnMutate: true } } as IknowSettings,
      worktreeIsolation: {
        provision: async ({ conversationId, root: sessionRoot }) => {
          calls.push({ conversationId, root: sessionRoot });
          // simulate rebind: return a task worktree path distinct from the engine root → gate
          return join(
            sessionRoot,
            ".iknow",
            "worktrees",
            conversationId ?? "x"
          );
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
    // ToolExecutionResult is a discriminated union; `message` only exists on
    // the failure arms, so read it through the kind check asserted above.
    const message = result.kind === "execution_failed" ? result.message : "";
    expect(message).toContain("[worktree_isolation]");
    // model-provision contract: an unbound mutate in the main repo is gated
    // directly, the gate NEVER provisions — creating the task worktree is the
    // model's job (the create-worktree ACI tool), so the block message must
    // point at it.
    expect(calls).toEqual([]);
    expect(message).toContain("create-worktree");
    // zero writes to the main repo (gating happens before tool execution)
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
    const message = result.kind === "execution_failed" ? result.message : "";
    expect(message).not.toContain("[worktree_isolation]");
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
    // reload must not use the bare cwd as mcpConfigRoot again
    const reloadIdx = depsSrc.indexOf("const reload");
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    const reloadBlock = depsSrc.slice(reloadIdx, reloadIdx + 400);
    expect(reloadBlock).toMatch(/mcpConfigRoot/);
    expect(reloadBlock).not.toMatch(/mcpConfigRoot:\s*cwd\b/);
  });
});
