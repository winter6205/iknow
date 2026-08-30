/**
 * #826 T7 — integration search-backend-fail-closed。
 *
 * 覆盖 spec `pluggable-web-search-backends` SC #4（4 状态 fail-closed）。
 *
 * Each case drives the **real** `loadIknowEnv` loader → **real**
 * `createDefaultAciRegistry` assembly → **real** `web_search` tool handler
 * (i.e. end-to-end through the registry's `web_search` factory closure —
 * mirrors `tests/integration/mcp-chain.test.ts` 的 "real subprocess + real
 * registry" 集成风格)。
 *
 * 4 状态（spec SC #4 / plan T7 acceptance #1）：
 *   ① `IKNOW_WEB_SEARCH_BACKEND=exa` + `EXA_API_KEY` unset
 *      → typed `ToolExecutionError` containing `"exa"` 字面值（missing_key）
 *   ② `EXA_API_KEY=${UNSET_VAR}` (placeholder resolution fails) + backend="exa"
 *      → typed `ToolExecutionError` for the same `missing_key` kind
 *   ③ `EXA_API_KEY=some-value` set + `IKNOW_WEB_SEARCH_BACKEND` unset
 *      → typed `ToolExecutionError` containing `backend_unset_with_key`
 *   ④ `backend=tavily` + tool input `search_url="..."`
 *      → schema reject with message `"search_url only valid with backend=bing"`
 *
 * 隔离：所有 .env.local fixture 走 tmp dir（不碰真实 repo 配置）。
 * process.env 直设路径走 `withCleanEnv` 闭包隔离避免 case 间污染（与
 * `tests/config/env-search-backend.test.ts` 同款机制）。
 *
 * 关于 state ③：`envOptionalEnum` 在 `IKNOW_WEB_SEARCH_BACKEND` 未设时
 * fallback 到 `"bing"`（spec Assumption 2 默认后端不变），loader 不会返
 * `undefined`。但 spec SC #4 钉的 `backend_unset_with_key` fail-closed
 * 路径依赖 `env.web.searchBackend === undefined` + 某 keyed key 已设 →
 * registry 透传给 tool → tool factory 的 `assertBackendConfig` 触发。
 * 本测试用 `loadIknowEnv` 走真实路径解析 `EXA_API_KEY=some-value`，再
 * override `web.searchBackend = undefined` 模拟「loader 看到 vendor key 但
 * 未选 backend」的契约态。这是 registry 装配路径里 `backend_unset_with_key`
 * 唯一可触发的形态；备注留作 T8 评估「loader 是否要返 undefined」参考。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";

/** #353 review: 既有 env 测试不测 settings，统一注入最小 settings 隔离真实
 * ~/.iknow/<cwd>/.iknow/settings.json。loadIknowEnv 传 settings 时跳过文件读取。 */
const EMPTY_SETTINGS: IknowSettings = { llm: { model: "test-model" } };

/** 隔离清单：searchBackend 选择 + 三个 vendor key。loader 不直读，但 case 间用
 * `withCleanEnv` 显式 delete，避免本机/CI 漏配导致 case 间污染。 */
const SEARCH_BACKEND_KEYS = [
  "IKNOW_WEB_SEARCH_BACKEND",
  "EXA_API_KEY",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
] as const;

function makeTmpCwd(prefix: string): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function withCleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of SEARCH_BACKEND_KEYS) {
    if (k in process.env) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Async 版本 — `tool.handler` 是 async，async test 路径要 await 这个隔离闭包。 */
async function withCleanEnvAsync<T>(fn: () => Promise<T>): Promise<T> {
  return withCleanEnv(fn);
}

/** 装配真实 registry 并返回 web_search 工具。env 由 caller 解析（loadIknowEnv
 * 或 override 后），传入 `env.web` 即可 —— 与 `createDefaultAciRegistry` 契约
 * 一致（`env: Pick<IknowEnv, "web">`）。 */
function buildRegistryWithWebSearch(env: {
  web: import("../../src/config/env.ts").WebEnv;
}) {
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot: "/tmp/integration-search-failclosed",
  });
  const tool = reg.catalog.get("web_search");
  assert.ok(tool, "web_search must be registered in the default registry");
  return tool;
}

describe("search-backend fail-closed integration (#826 T7, spec SC #4)", () => {
  beforeEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });

  // ===========================================================================
  // State ① — backend="exa" + EXA_API_KEY unset → missing_key (含 "exa")
  // ===========================================================================

  it("① IKNOW_WEB_SEARCH_BACKEND=exa + EXA_API_KEY unset → typed ToolExecutionError containing 'exa'", async () => {
    await withCleanEnvAsync(async () => {
      const { cwd, cleanup } = makeTmpCwd("iknow-search-backend-failclosed-1-");
      try {
        mkdirSync(cwd, { recursive: true });
        // .env.local 里只设 backend=exa；EXA_API_KEY 不设 → loader
        // 走 expandPlaceholders(undefined, file) → undefined。
        writeFileSync(
          join(cwd, ".env.local"),
          "IKNOW_WEB_SEARCH_BACKEND=exa\n"
        );

        const env = loadIknowEnv(cwd, EMPTY_SETTINGS);
        // 锁 loader 行为：backend 透传 exa、key 缺失（registry 必须据此 fail-closed）。
        assert.equal(env.web.searchBackend, "exa");
        assert.equal(env.web.exaApiKey, undefined);

        const tool = buildRegistryWithWebSearch({ web: env.web });

        // handler 是 async；用 `await assert.rejects`（不是 assert.throws，
        // 后者不会捕获 Promise rejection —— 之前实测 unhandled rejection）。
        await assert.rejects(
          () => tool.handler({ query: "test query" }),
          (err: unknown) => {
            return (
              err instanceof ToolExecutionError && err.message.includes("exa")
            );
          },
          "expected ToolExecutionError mentioning 'exa' when key missing"
        );
      } finally {
        cleanup();
      }
    });
  });

  // ===========================================================================
  // State ② — EXA_API_KEY=${UNSET_VAR} + backend="exa" → missing_key
  // ===========================================================================

  it("② EXA_API_KEY='${UNSET_VAR}' + IKNOW_WEB_SEARCH_BACKEND=exa → missing_key (placeholder resolution fails)", async () => {
    await withCleanEnvAsync(async () => {
      const { cwd, cleanup } = makeTmpCwd("iknow-search-backend-failclosed-2-");
      try {
        mkdirSync(cwd, { recursive: true });
        // 占位符解析失败路径：file literal `${UNSET_VAR}` → expandPlaceholders
        // 返 undefined（与 settings.llm.apiKey 同链路；spec acceptance #6）。
        writeFileSync(
          join(cwd, ".env.local"),
          ["IKNOW_WEB_SEARCH_BACKEND=exa", "EXA_API_KEY=${UNSET_VAR}"].join(
            "\n"
          ) + "\n"
        );

        const env = loadIknowEnv(cwd, EMPTY_SETTINGS);
        // loader 把 `${UNSET_VAR}` 折成 undefined（不抛错、不空串）。
        assert.equal(env.web.searchBackend, "exa");
        assert.equal(env.web.exaApiKey, undefined);

        const tool = buildRegistryWithWebSearch({ web: env.web });

        await assert.rejects(
          () => tool.handler({ query: "test query" }),
          (err: unknown) => {
            return (
              err instanceof ToolExecutionError &&
              err.message.includes("missing_key")
            );
          },
          "expected ToolExecutionError with kind 'missing_key' for unresolved placeholder"
        );
      } finally {
        cleanup();
      }
    });
  });

  // ===========================================================================
  // State ③ — EXA_API_KEY set + IKNOW_WEB_SEARCH_BACKEND unset → backend_unset_with_key
  // ===========================================================================

  it("③ EXA_API_KEY set + IKNOW_WEB_SEARCH_BACKEND unset → typed ToolExecutionError (backend_unset_with_key kind)", async () => {
    await withCleanEnvAsync(async () => {
      const { cwd, cleanup } = makeTmpCwd("iknow-search-backend-failclosed-3-");
      try {
        mkdirSync(cwd, { recursive: true });
        // .env.local 只设 EXA_API_KEY，不设 backend。loader 的 `envOptionalEnum`
        // 默认到 "bing"，但 spec SC #4 state ③ 要测的是「loader 看到 vendor key
        // 但未选 backend」—— 这是 registry 装配路径里 `backend_unset_with_key`
        // 唯一可触发的形态：env.web.searchBackend === undefined + 某 keyed
        // key 已设 → tool 的 assertBackendConfig 判定配错静默回 Bing 风险 →
        // 抛 typed error。
        writeFileSync(
          join(cwd, ".env.local"),
          "EXA_API_KEY=exa-key-from-fixture-12345\n"
        );

        const loadedEnv = loadIknowEnv(cwd, EMPTY_SETTINGS);
        // 用 loader 解析 EXA_API_KEY（真实路径），再 override searchBackend
        // 为 undefined 模拟「未选 backend」的契约态（spec Assumption 6
        // 「防配错静默回 Bing」）。registry 的 web_search 工厂闭包据此把
        // backend=undefined 透传给 createWebSearchTool，触发 fail-closed。
        const env = {
          web: {
            searchUrl: loadedEnv.web.searchUrl,
            proxy: loadedEnv.web.proxy,
            searchBackend: undefined as
              "bing" | "tavily" | "exa" | "brave" | undefined,
            exaApiKey: loadedEnv.web.exaApiKey,
            tavilyApiKey: loadedEnv.web.tavilyApiKey,
            braveApiKey: loadedEnv.web.braveApiKey,
          },
        };

        // 锁 loader + override 行为：key 解析正确、backend 显式 undefined。
        assert.equal(env.web.exaApiKey, "exa-key-from-fixture-12345");
        assert.equal(env.web.searchBackend, undefined);

        const tool = buildRegistryWithWebSearch(env);

        await assert.rejects(
          () => tool.handler({ query: "test query" }),
          (err: unknown) => {
            return (
              err instanceof ToolExecutionError &&
              err.message.includes("backend_unset_with_key")
            );
          },
          "expected ToolExecutionError with kind 'backend_unset_with_key'"
        );
      } finally {
        cleanup();
      }
    });
  });

  // ===========================================================================
  // State ④ — backend="tavily" + search_url="..." → schema reject
  // ===========================================================================

  it("④ backend=tavily + tool input search_url='...' → schema reject with 'search_url only valid with backend=bing'", async () => {
    await withCleanEnvAsync(async () => {
      const { cwd, cleanup } = makeTmpCwd("iknow-search-backend-failclosed-4-");
      try {
        mkdirSync(cwd, { recursive: true });
        // backend=tavily 同时设 TAVILY_API_KEY —— handler entry 顺序是先
        // `assertBackendConfig`（需要 key 通过）再 `assertSearchUrlAllowed`
        // （schema reject）；key 缺失会先撞 missing_key 路径，掩盖 schema
        // reject。spec Assumption 9 钉的就是「keyed backend + search_url」
        // 应当 schema reject，与 v0 SSRF 验证路径无关。
        writeFileSync(
          join(cwd, ".env.local"),
          [
            "IKNOW_WEB_SEARCH_BACKEND=tavily",
            "TAVILY_API_KEY=tavily-key-from-fixture-67890",
          ].join("\n") + "\n"
        );

        const env = loadIknowEnv(cwd, EMPTY_SETTINGS);
        assert.equal(env.web.searchBackend, "tavily");
        assert.equal(env.web.tavilyApiKey, "tavily-key-from-fixture-67890");

        const tool = buildRegistryWithWebSearch({ web: env.web });

        await assert.rejects(
          () =>
            tool.handler({
              query: "test query",
              search_url: "https://attacker.example.com/",
            }),
          (err: unknown) => {
            return (
              err instanceof ToolExecutionError &&
              err.message.includes("search_url only valid with backend=bing")
            );
          },
          "expected ToolExecutionError rejecting search_url override on keyed backend"
        );
      } finally {
        cleanup();
      }
    });
  });
});
