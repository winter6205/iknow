/**
 * Locked sentence 5 钉（plans/session-fg-handoff-interrupt.md §Locked sentences
 * / Task 6）：未发生 `lsp_*`（及同族符号工具）调用前，装配不得 warmup / spawn
 * language server；第一次这类工具调用再起，且同一 engine / worker 只 arm 一次。
 *
 * 断言面（ground truth 选择）：
 *   - warmup 唯一的 spawn 入口是 `client.ts` 的 `getClient`（client.ts 是
 *     spawn 单漏斗，见 `getClientDetailed` 的 `spawnClient` 调用点），故以
 *     `getClient` mock 的调用次数作为「warmup 是否真的去 spawn」的判据；
 *   - 触发点 = `LoopEngineDeps.registry.get(name)` —— loop-engine 工具相位里
 *     唯一的按名解析点（`runToolPhase` → `partitionConcurrencyWaves` 分类），
 *     每个模型工具调用必经。engine / worker 两条装配路径都覆盖。
 *   - 样本文件真建在临时根上（warmup 按扩展名扫盘选 server），单个 `.ts`
 *     样本 ⇒ 一次 warmup 恰好一次 getClient：次数 1 与 2 有判别力。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessEngine } from "../../../src/harness/build-engine.js";
import { createWorkerDeps } from "../../../src/harness/subagent/worker.js";
import {
  getWarmupOutcome,
  withLazyLspWarmup,
} from "../../../src/harness/lsp/warmup.js";
import { SYMBOL_QUERY_TOOL_NAMES } from "../../../src/harness/aci/tools/symbol.js";
import { SYMBOL_MUTATE_TOOL_NAMES } from "../../../src/harness/aci/tools/symbol-mutate.js";
import type { RegistryImpl } from "../../../src/harness/tools/registry.js";
import { createStubModel } from "../../../src/harness/stubs/stub-model.js";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.js";
import { createNoopTraceService } from "../../../src/harness/trace/noop.js";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.js";
import type { IknowEnv } from "../../../src/config/env.js";
import type { BuiltEngine } from "../../../src/harness/build-engine.js";

const { mockGetClient, mockEnsureOpen } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockEnsureOpen: vi.fn(),
}));

// 只替换 getClient（warmup 的 spawn 入口）；getClientDetailed 及其余导出透传真实
// 实现 —— 装配与本文件都不执行真实 handler，不会真起 language server。
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
  };
});

const built: BuiltEngine[] = [];
const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

/** 一个 `.ts` 样本 ⇒ 只有 typescript server 命中 warmup 扫描。 */
function makeRootWithTsSample(prefix: string): string {
  const root = makeRoot(prefix);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

/** fire-and-forget 的观察窗：给后台 warmup 落地的时间。 */
const flush = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeEngineEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-lazy-warmup",
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

function makeWorkerEnv(): IknowEnv {
  return {
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
}

async function buildEngine(root: string): Promise<BuiltEngine> {
  const engine = await buildHarnessEngine({
    env: makeEngineEnv(),
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: root,
    userHome: root,
    workspaceRoot: root,
    sandboxRoot: root,
    skipCountTokens: true,
    settings: {},
  });
  built.push(engine);
  return engine;
}

async function buildWorker(root: string) {
  return await createWorkerDeps({
    env: makeWorkerEnv(),
    sandboxRoot: root,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    role: "general-purpose",
  });
}

beforeEach(() => {
  mockGetClient.mockReset();
  mockGetClient.mockResolvedValue({ ensureOpen: mockEnsureOpen });
  mockEnsureOpen.mockReset();
  mockEnsureOpen.mockResolvedValue(undefined);
});

afterAll(async () => {
  await Promise.all(built.map((b) => b.shutdown?.()));
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

// ── 1. 装配：不 warmup、不 spawn（acceptance） ─────────────────────────────────

describe("装配完成且从未调用 language-server 工具 → warmup 不 spawn", () => {
  it("engine 装配（根上有 .ts 样本）→ getClient 零调用、outcome 仍未 settle", async () => {
    const root = makeRootWithTsSample("lazy-warmup-engine-");

    await buildEngine(root);

    // 给 fire-and-forget 一个落地窗口：warmup 若在装配期被 arm，它会异步跑，
    // 不经这格就断言等于还没等到那件事发生；经过这格仍是零调用才说明它压根
    // 没被 arm。
    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(getWarmupOutcome()).toBeUndefined();
  });

  it("worker 装配（根上有 .ts 样本）→ getClient 零调用、outcome 仍未 settle", async () => {
    const root = makeRootWithTsSample("lazy-warmup-worker-");

    await buildWorker(root);

    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(getWarmupOutcome()).toBeUndefined();
  });
});

// ── 2. 首次 language-server 工具名解析：arm 一次 ──────────────────────────────

describe("首次 language-server 工具调用 arm warmup（恰好一次）", () => {
  it("engine deps.registry：非 LSP 名不 arm；find_symbol arm 一次；同族后续不再 arm", async () => {
    const root = makeRootWithTsSample("lazy-warmup-trigger-");
    const engine = await buildEngine(root);
    const registry = engine.deps.registry;

    // 包装视图必须原样透传（list 非空且含符号工具，get 命中原 registry）。
    expect(registry.list().map((d) => d.name)).toContain("find_symbol");

    // 非 language-server 工具名解析（含高频常驻件）→ 不 arm。
    expect(registry.get("read_file")).toBeDefined();
    expect(registry.get("bash")).toBeDefined();
    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();

    // 第一次 language-server 工具调用 → arm（fire-and-forget，同步返回）。
    expect(registry.get("find_symbol")).toBeDefined();
    await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    // 同族其余两族（改工具 / 坐标面）与重复解析 → 不再 arm。
    expect(registry.get("rename_symbol")).toBeDefined();
    // 坐标面 `lsp_*` 已退役出模型面 → 名解析为 undefined；这里只钉「不再 arm」。
    expect(registry.get("lsp_hover")).toBeUndefined();
    expect(registry.get("find_symbol")).toBeDefined();
    await flush();
    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });

  it("engine deps.registry：首次即坐标面 lsp_*（前缀族）也 arm", async () => {
    const root = makeRootWithTsSample("lazy-warmup-coord-");
    const engine = await buildEngine(root);

    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();

    engine.deps.registry.get("lsp_hover");
    await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
  });

  it("视图的判定名集 = 工具层 SSOT 的 15 件符号工具（无静默漏网）", async () => {
    const ssot = [...SYMBOL_QUERY_TOOL_NAMES, ...SYMBOL_MUTATE_TOOL_NAMES];
    // 数量断言先于逐个 arm：数组增删一件时它先炸，报的是「SSOT 数量变了」
    // 而不是 loop 里某一件的 arm 超时。真正的漂移诊断在循环的 `arm for ${name}`
    // 上（warmup 视图漏判该名 → 该 name 永不 arm）。
    expect(
      ssot,
      "SYMBOL_QUERY_TOOL_NAMES + SYMBOL_MUTATE_TOOL_NAMES 件数变了：新增/删除符号工具时，warmup 视图的判定集（warmup.ts 的 LANGUAGE_SERVER_TOOL_NAMES，取自同一组 SSOT 数组）会同步变化；此处必须同步更新，并确认装配面工具表也是 15 件。"
    ).toHaveLength(15);
    const root = makeRootWithTsSample("lazy-warmup-ssot-");

    // 每个名字单独包一份视图（latch 一次性）→ 逐个观察该名 resolve 是否 arm。
    for (const name of ssot) {
      const view = withLazyLspWarmup(
        {
          list: () => [],
          get: () => undefined,
          getValidator: () => undefined,
        } as unknown as RegistryImpl,
        { directory: root }
      );
      view.get(name);
      await vi.waitFor(
        () => expect(mockGetClient, `arm for ${name}`).toHaveBeenCalledTimes(1),
        { timeout: 5_000 }
      );
      await flush(); // 吸收本轮后台收尾，避免计入下一轮的计数
      mockGetClient.mockClear();
    }
  });

  it("worker deps.registry 同缝：find_symbol arm 一次，第二次不再 arm", async () => {
    const root = makeRootWithTsSample("lazy-warmup-worker-trigger-");
    const deps = await buildWorker(root);

    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();

    expect(deps.registry.get("find_symbol")).toBeDefined();
    await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    expect(deps.registry.get("get_symbols_overview")).toBeDefined();
    await flush();
    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });
});
