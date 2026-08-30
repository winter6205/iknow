/**
 * worker LSP 装配接线 — lsp-optimization 二期 B6。
 *
 * createWorkerRuntime 内（registry 构造前）同构装配：
 *   const lspCtx = { directory: sandboxRoot, idleTimeoutMs: DEFAULT };
 *   const lspNotifier = createLspNotifier(lspCtx);
 *   startLspWarmup(lspCtx);
 *   registry opts: onEdit: (file) => lspNotifier.invalidate(file)
 *
 * 覆盖：
 *   1. startLspWarmup 以 `{ directory: sandboxRoot }` 被调用（SSOT 同根），
 *      且不阻塞装配（fire-and-forget）。
 *   2. edit_file handler 写盘成功后触发 notifier 链路（onEdit → invalidate
 *      → client.notifyChange(file)）—— 端到端观察 onEdit 注入。
 *
 * Mock 策略：mock warmup 模块（避免测试期扫描 tmp）；mock client 模块的
 * getClient 使 notifier 的 notifyChange 可观测。notifier 保持真实实现
 * （invalidate → notifyChange 的 fire-and-forget 语义一并被覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockGetClient, mockStartLspWarmup } = vi.hoisted(() => ({
  mockGetClient: vi.fn<() => Promise<unknown>>(),
  mockStartLspWarmup: vi.fn(),
}));

vi.mock("../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
  };
});

vi.mock("../../src/harness/lsp/warmup.js", () => ({
  startLspWarmup: (...args: unknown[]) => mockStartLspWarmup(...args),
}));

import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "../../src/harness/lsp/client.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import type { CreateWorkerDepsOptions } from "../../src/harness/subagent/worker.ts";
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

function hermeticOpts(sandboxRoot: string): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
  };
}

beforeEach(() => {
  mockGetClient.mockReset();
  mockGetClient.mockResolvedValue(undefined);
  mockStartLspWarmup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker LSP wiring (phase2 B6)", () => {
  it("calls startLspWarmup with sandboxRoot + default idleTimeoutMs (fire-and-forget)", async () => {
    const sb = await mkdtemp(join(tmpdir(), "iknow-worker-lsp-warm-"));
    try {
      await createWorkerDeps(hermeticOpts(sb));
      expect(mockStartLspWarmup).toHaveBeenCalledTimes(1);
      expect(mockStartLspWarmup).toHaveBeenCalledWith({
        directory: sb,
        idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS,
      });
    } finally {
      await rm(sb, { recursive: true, force: true });
    }
  });

  it("routes edit_file writes through the onEdit → notifier → notifyChange chain", async () => {
    const sb = await mkdtemp(join(tmpdir(), "iknow-worker-lsp-edit-"));
    try {
      const target = join(sb, "a.ts");
      await writeFile(target, "const a = 1;\n", "utf8");

      const notifyChange = vi.fn(async (_file: string) => undefined);
      mockGetClient.mockResolvedValue({ notifyChange });

      const deps = await createWorkerDeps(hermeticOpts(sb));
      const def = deps.registry.get("edit_file");
      expect(def).toBeDefined();

      await def!.handler({
        path: target,
        old_str: "const a = 1;",
        new_str: "const a = 2;",
      });

      // edit_file 写盘成功 → onEdit(file) → notifier.invalidate(file) →
      // client.notifyChange(file)（异步 fire-and-forget，等一拍 microtask）。
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(notifyChange).toHaveBeenCalledWith(target);
    } finally {
      await rm(sb, { recursive: true, force: true });
    }
  });
});
