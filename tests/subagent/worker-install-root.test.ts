/**
 * T5 (plans/closed-world-bash-fence.md) — worker registry installRoot 透传。
 *
 * 查证结论(T4 移交观察的裁决依据):worker 的 bash 是**真实执行面** ——
 * createWorkerRuntime 经 createDefaultAciRegistry 装配真实 registry(reg.inner
 * → executor),bash 工厂在 registry 构造期即实例化(registry.ts `tools =
 * toolsetNames.map(factories[n]!())`),handler 在调用时经 createFsPolicy /
 * createBwrapFence 构造围栏。缺席 installRoot 时闭世界读白名单缺 §9.2 #4
 * 合同读根(项目自身工具链 node_modules/.bin 的读通道)。
 *
 * 接线形态与 verify sandbox-run 同款:opts.installRoot 显式传入即覆盖,缺省
 * 回退 `resolveInstallRoot()` 进程级 SSOT(worker 进程没有 sessionRoots,但
 * 该解析锚 `import.meta.url`,在 worker 进程内同样成立)。
 *
 * 手法:module-mock bash.js(registry 的 named import 落到 spy;registry 本体
 * 保持真实),与 tests/harness/build-engine-install-root.test.ts 同款。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/harness/aci/tools/bash.js", () => ({
  createBashTool: vi.fn(() => ({
    name: "bash",
    description: "stub",
    inputSchema: { type: "object" },
    handler: async () => ({}),
    aci: {
      category: "execute",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "build",
    },
  })),
}));

import { createBashTool } from "../../src/harness/aci/tools/bash.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { resolveInstallRoot } from "../../src/harness/session-roots.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

async function buildWorker(opts: { installRoot?: string }): Promise<string> {
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), "worker-install-root-sandbox-")
  );
  await createWorkerDeps({
    env: TEST_ENV,
    sandboxRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    ...(opts.installRoot !== undefined
      ? { installRoot: opts.installRoot }
      : {}),
  });
  return sandboxRoot;
}

function bashOpts(): Record<string, unknown> {
  const calls = vi.mocked(createBashTool).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1]?.[1] ?? {}) as Record<string, unknown>;
}

describe("createWorkerDeps — installRoot threaded to the bash factory (T5)", () => {
  it("explicit installRoot threads verbatim into the bash factory", async () => {
    const INSTALL = await mkdtemp(join(tmpdir(), "worker-install-root-"));
    const sandboxRoot = await buildWorker({ installRoot: INSTALL });
    expect(bashOpts().installRoot).toBe(INSTALL);
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("installRoot omitted → SSOT fallback resolveInstallRoot() is threaded (no silent empty)", async () => {
    const sandboxRoot = await buildWorker({});
    expect(bashOpts().installRoot).toBe(resolveInstallRoot());
    await rm(sandboxRoot, { recursive: true, force: true });
  });
});
