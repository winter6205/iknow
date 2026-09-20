/**
 * Invariant: before any `lsp_*` (or sibling symbol-tool) call, assembly must
 * not warmup / spawn a language server. The first such call triggers warmup,
 * and each engine / worker arms at most once.
 *
 * Assertion surface (why these are the ground truth):
 *   - `getClient` in `client.ts` is the single spawn funnel for warmup (see
 *     the `spawnClient` call site in `getClientDetailed`), so counting
 *     `getClient` mock calls answers "did warmup actually try to spawn";
 *   - the trigger point is `LoopEngineDeps.registry.get(name)` — the only
 *     name-resolution site in the loop-engine tool phase (`runToolPhase` →
 *     `partitionConcurrencyWaves` classification), hit by every model tool
 *     call. Both engine and worker assembly paths are covered.
 *   - the sample file really lives on a temp root (warmup scans by extension
 *     to pick servers), and a single `.ts` sample ⇒ exactly one getClient per
 *     warmup, so counts 1 vs 2 are distinguishable.
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

// Mock only getClient (warmup's spawn entry); getClientDetailed and all other
// exports pass through to the real implementation — neither assembly nor this
// file runs real handlers, so no language server is ever actually spawned.
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

/** One `.ts` sample ⇒ only the typescript server matches warmup's scan. */
function makeRootWithTsSample(prefix: string): string {
  const root = makeRoot(prefix);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

/** Observation window for fire-and-forget: lets a background warmup land. */
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

// ── 1. assembly: no warmup, no spawn (acceptance) ────────────────────────────

describe("装配完成且从未调用 language-server 工具 → warmup 不 spawn", () => {
  it("engine 装配（根上有 .ts 样本）→ getClient 零调用、outcome 仍未 settle", async () => {
    const root = makeRootWithTsSample("lazy-warmup-engine-");

    await buildEngine(root);

    // Give fire-and-forget a landing window: if warmup were armed during
    // assembly it would run async, and asserting without waiting would just
    // mean we hadn't waited long enough; zero calls after this window proves
    // it was never armed at all.
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

// ── 2. first language-server tool-name resolution: arm once ──────────────────

describe("首次 language-server 工具调用 arm warmup（恰好一次）", () => {
  it("engine deps.registry：非 LSP 名不 arm；find_symbol arm 一次；同族后续不再 arm", async () => {
    const root = makeRootWithTsSample("lazy-warmup-trigger-");
    const engine = await buildEngine(root);
    const registry = engine.deps.registry;

    // The wrapped view must pass through unchanged (list non-empty with
    // symbol tools, get hits the original registry).
    expect(registry.list().map((d) => d.name)).toContain("find_symbol");

    // Resolving non-language-server tool names (incl. hot resident tools) → no arm.
    expect(registry.get("read_file")).toBeDefined();
    expect(registry.get("bash")).toBeDefined();
    await flush();
    expect(mockGetClient).not.toHaveBeenCalled();

    // First language-server tool call → arm (fire-and-forget, returns sync).
    expect(registry.get("find_symbol")).toBeDefined();
    await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    // Sibling families (mutate tools / coordinate surface) and repeat
    // resolution → no re-arm.
    expect(registry.get("rename_symbol")).toBeDefined();
    // The `lsp_*` coordinate surface has retired from the model surface →
    // resolves to undefined; this only pins "no re-arm".
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
    // Count assertion precedes the per-name arming: when the array grows or
    // shrinks by one it fails first, reporting "the SSOT count changed"
    // rather than an arm timeout on some tool inside the loop. The real
    // drift diagnostic is the per-name `arm for ${name}` message below (the
    // warmup view missing a name → that name never arms).
    expect(
      ssot,
      "SYMBOL_QUERY_TOOL_NAMES + SYMBOL_MUTATE_TOOL_NAMES 件数变了：新增/删除符号工具时，warmup 视图的判定集（warmup.ts 的 LANGUAGE_SERVER_TOOL_NAMES，取自同一组 SSOT 数组）会同步变化；此处必须同步更新，并确认装配面工具表也是 15 件。"
    ).toHaveLength(15);
    const root = makeRootWithTsSample("lazy-warmup-ssot-");

    // Wrap each name in its own view (the latch is one-shot per view) →
    // observe per name whether resolving it arms warmup.
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
      await flush(); // absorb this round's background wrap-up so it doesn't pollute the next count
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
