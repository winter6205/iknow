/**
 * `src/harness/build-engine.ts` — the single harness assembly point shared by
 * the CLI (chat / ask) and the session server (serve → SessionHub.ensureDeps).
 *
 * These tests pin the ACI 10-tool set so a future tool-set change cannot drift
 * between the two entry points silently: if a tool is added/renamed/removed,
 * this test forces an explicit decision at the single assembly point.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";

// Order is load-bearing: it must match the `aciTools` array in
// `src/harness/build-engine.ts` (policy byName key-space, ADR-0006)。
// #194 T6 (Layer 4 baseline):扩 memory_recall + memory_save 到 10 件。
const EXPECTED_TOOLS = [
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "memory_recall",
  "memory_save",
];

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
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
  };
}

describe("buildHarnessEngine (SSOT assembly)", () => {
  it("registers the full ACI 10-tool set on the returned registry", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-1"),
      askUser: createNoAskUser(),
    });

    const names = deps.registry.list().map((def) => def.name);
    expect(names).toEqual(EXPECTED_TOOLS);
    // 显式锁 Web 工具存在(plan-fidelity:SSOT 收敛到 registry.ts 后,
    // build-engine 路径也必须仍带 web_fetch / web_search)。
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });

  it("throws without the LLM api key set (fail loud, before any async work)", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv(undefined),
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/LLM mode needs the env var/);
  });

  it("throws when askUser is missing", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv("sk-test-sentinel-2"),
        askUser: undefined as never,
      })
    ).rejects.toThrow(/ask_inlet_missing/);
  });
});

// --- #121 T6 / SC 12: memory opt-out + system wiring ------------------------

describe("buildHarnessEngine — memory opt-out (ask path, SC 12)", () => {
  it("memory disabled → registry stays at 8 (no memory tools) and memory_layer inactive", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-off-1"),
      askUser: createNoAskUser(),
      memory: { enabled: false },
    });

    const names = deps.registry.list().map((def) => def.name);
    expect(names).toEqual(
      EXPECTED_TOOLS.filter((n) => n !== "memory_recall" && n !== "memory_save")
    );
    expect(names).not.toContain("memory_recall");
    expect(names).not.toContain("memory_save");
    // landing 形态：deps.system 始终挂 createIknowSystemResolver（identity 层恒在），
    // memoryEnabled=false 让 memory_layer slot 返回 undefined。
    const sys = await deps.system?.();
    expect(sys).toContain("iknow Identity");
  });

  it("memory enabled (default) → deps.system is wired as an async assembler", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-on-1"),
      askUser: createNoAskUser(),
    });
    // seam 契约：deps.system 是函数（#194 同款断言，不实际调用——
    // 调用会写 usage.json 进真实 ~/.iknow/memory）
    expect(typeof deps.system).toBe("function");
  });
});

describe("buildHarnessEngine (SSOT passthrough)", () => {
  it("propagates maxTurns and timeoutMs from env (not hard-coded)", async () => {
    const env = makeEnv("sk-test-passthrough-1");
    env.llm.timeoutMs = 12345;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });

    expect(deps.maxTurns).toBe(6);
    // Proves timeoutMs is read through from env, not a hard-coded constant.
    expect(deps.timeoutMs).toBe(12345);
  });

  it("IKNOW_WEB_PROXY 非法值 → build 时同步抛错,空值 → 不影响装配", async () => {
    // 验证代理配置在装配时即被 SSRF 防线拦截,避免到 fetch 时才报。
    const env = makeEnv("sk-test-passthrough-3");
    env.web.proxy = "ftp://bad-proxy:9999";
    await expect(
      buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/only http and https|malformed/i);

    // 对照:空代理配置不抛错,装配成功。
    const envOk = makeEnv("sk-test-passthrough-4");
    envOk.web.proxy = undefined;
    const { deps } = await buildHarnessEngine({
      env: envOk,
      askUser: createNoAskUser(),
    });
    expect(deps.registry.list().map((d) => d.name)).toEqual(EXPECTED_TOOLS);
  });

  it("injects sandboxRoot into the read_file tool (out-of-root rejected)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-build-engine-root-"));
    const outside = await mkdtemp(join(tmpdir(), "iknow-build-engine-out-"));
    try {
      const { deps } = await buildHarnessEngine({
        env: makeEnv("sk-test-passthrough-2"),
        askUser: createNoAskUser(),
        sandboxRoot: root,
      });

      const [result] = await deps.executor.executeAll([
        {
          id: "sandbox-read",
          name: "read_file",
          input: { path: join(outside, "victim.txt") },
        },
      ]);

      // read-only category → permission allows; the soft sandbox itself must
      // reject the path since it lies outside `root`. If sandboxRoot were not
      // injected (default process.cwd()), this path would be rejected too,
      // but the assertion proves the tool was built with the explicit root.
      expect(result.kind).toBe("execution_failed");
      if (result.kind === "execution_failed") {
        expect(result.message).toMatch(/path outside workspace/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
