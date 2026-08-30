/**
 * BraveBackend (#826 T6) — stub tests for the Brave v1 stub path.
 *
 * 覆盖契约（spec SC #8 + T6 acceptance criteria）：
 *   - basic: schema shape — `id === "brave"`，三方法签名同形
 *     （fetchResults / project / describe）。empty 形态由 schema 形态覆盖
 *     （v1 不实现真 fetch，故没有 zero-result empty 投影路径）。
 *   - **not_shipped**：fetchResults / project / describe 三方法均抛 typed
 *     `SearchBackendError(kind="not_shipped", endpoint, message)`，
 *     message 含 backend id "brave" + v2 提示。
 *     spec Assumption 8 钉"Brave v1 不实现 `project`"；T6 acceptance #2/#3
 *     推荐"all three methods throw typed not_shipped for uniform semantics"，
 *     本测试组既覆盖 single-method 行为也覆盖一致性契约。
 *   - factory wiring: `BACKENDS.brave` yields a backend with `id === "brave"`
 *     （T6 替换 placeholder 工厂）。
 *   - handler integration: calling handler with `backend="brave"` + stub
 *     fetch + `BRAVE_API_KEY` set in deps 仍抛 `not_shipped` 1:1 转译
 *     为 `ToolExecutionError`（spec SC #8 + handler 出口契约）。
 *
 * 注：本文件不测真 HTTP（v1 stub 不发请求）。opt-in real HTTP probe 走 T8。
 * v2 真 fetch 推进时本测试组需重写（fetchResults 不抛、project 实现、
 * describe 落真形态）—— 与 TavilyBackend.test.ts 同形态。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../../../src/harness/errors.ts";
import {
  BACKENDS,
  BraveBackend,
  createWebSearchTool,
  type WebSearchToolDeps,
} from "../../../../../../src/harness/aci/tools/web-search.ts";
import { isSearchBackendError } from "../../../../../../src/harness/aci/tools/web-search-errors.ts";
import type {
  GuardFetchFn,
  GuardLookupFn,
} from "../../../../../../src/harness/aci/tools/network-guard.ts";

/**
 * Brave vendor endpoint（spec Out-of-scope：v2 真 fetch 推进时使用），
 * 本测试组仅通过 not_shipped error.endpoint 字段间接断言；常量值与
 * 真实 vendor URL 形态对齐（Brave Search API v1）。
 */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_DOMAIN = "api.search.brave.com";

/**
 * 假 Brave API key —— handler integration 测试验断言 key 字面值**绝不**
 * 出现在 error message 里（与 TavilyBackend 同形态）。
 */
const FAKE_BRAVE_KEY = "brave-secret-do-not-leak-0123456789";

describe("BraveBackend — schema shape (#826 T6)", () => {
  it("basic: id === 'brave' and three method signatures exist", () => {
    const backend = new BraveBackend();
    assert.equal(backend.id, "brave");
    assert.equal(typeof backend.fetchResults, "function");
    assert.equal(typeof backend.project, "function");
    assert.equal(typeof backend.describe, "function");
  });
});

describe("BraveBackend — not_shipped on all three methods (#826 T6)", () => {
  const backend = new BraveBackend();

  it.each(["fetchResults", "project", "describe"] as const)(
    "%s throws typed not_shipped with 'brave' in message and v2 hint",
    async (method) => {
      // sync throw（project / describe 都是同步抛 typed）和 async throw
      // （fetchResults 抛 rejected promise）走统一
      // `Promise.resolve().then(...)` 把 sync throw 也归一为 promise
      // rejection，与 TavilyBackend 同形态（spec SC #8 + T5 acceptance
      // 「the helper already does Promise.resolve().then(...)」）。
      await assert.rejects(
        Promise.resolve().then(() => {
          if (method === "fetchResults") {
            return backend.fetchResults({ query: "x", maxResults: 5 });
          }
          if (method === "project") {
            return backend.project({}, 5);
          }
          // describe
          return backend.describe({}, Date.now() - 1);
        }),
        (err: unknown) => {
          assert.ok(
            isSearchBackendError(err),
            `expected typed SearchBackendError, got ${String(err)}`
          );
          assert.equal(err.kind, "not_shipped");
          assert.ok(err.message.includes("brave"), err.message);
          // v2 hint: 提示等 v2 真 fetch 推进（与 TavilyBackend 同形态）。
          assert.ok(err.message.includes("v2"), err.message);
          assert.equal(err.endpoint, BRAVE_DOMAIN);
          return true;
        }
      );
    }
  );

  it("fetchResults does not surface any apiKey / Authorization in the message", async () => {
    // v1 stub 不读 apiKey（无 constructor 参数），但 message 仍过
    // `createSearchBackendError` 的 redactAuthSecrets 兜底。验证 key 字面值
    // 不出现在 message 里 —— 与 TavilyBackend 同形态（spec Assumption 6）。
    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.ok(!err.message.includes(FAKE_BRAVE_KEY), err.message);
        assert.ok(!/bearer/i.test(err.message), err.message);
        assert.ok(!/authorization/i.test(err.message), err.message);
        return true;
      }
    );
  });
});

describe("BraveBackend — factory wiring (#826 T6)", () => {
  it("BACKENDS.brave yields a BraveBackend instance with id === 'brave'", () => {
    // T6 替换 placeholder 工厂 —— BACKENDS.brave 现在返 BraveBackend 实例，
    // 不再是占位 plain object。assertion 钉「id === 'brave'」+ instanceof
    // 双线验证类型契约。
    const factory = BACKENDS.brave;
    assert.equal(typeof factory, "function");
    const instance = factory({
      guardDeps: {
        fetch: (() => undefined) as unknown as GuardFetchFn,
        lookup: async () => [],
      },
      endpoint: "https://example.invalid",
      apiKey: FAKE_BRAVE_KEY,
    });
    assert.ok(instance instanceof BraveBackend);
    assert.equal(instance.id, "brave");
  });

  it("BRAVE_ENDPOINT constant matches the documented vendor URL", () => {
    // 钉死 endpoint 常量值 —— 防 T6 重构时不小心改写 url。
    // 通过 not_shipped error 的 endpoint 字段间接断言（与
    // TavilyBackend.test.ts 同形态）。
    const backend = new BraveBackend();
    return backend.fetchResults({ query: "x", maxResults: 5 }).then(
      () => {
        assert.fail("fetchResults should have rejected");
      },
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.endpoint, BRAVE_DOMAIN);
        assert.equal(err.endpoint, new URL(BRAVE_ENDPOINT).hostname);
      }
    );
  });
});

describe("BraveBackend — handler integration (#826 T6)", () => {
  it("handler with backend='brave' + stub fetch + BRAVE_API_KEY → not_shipped ToolExecutionError", async () => {
    // handler 集成路径：handler entry 先过 assertBackendConfig（brave + key
    // 已设 → 不抛 missing_key），到 loadSearchResults 时 backend.fetchResults
    // 抛 typed not_shipped，handler 出口 try/catch 1:1 转译为 ToolExecutionError
    // （spec SC #8）。stub fetch / lookup 注入是为了覆盖「handler 走到
    // assertBackendConfig 之后、未真出网」这一支 —— 验证抛出前没真发网络。
    const fetch: GuardFetchFn = (() => undefined) as unknown as GuardFetchFn;
    const lookup: GuardLookupFn = async () => [];
    const tool = createWebSearchTool({
      fetch,
      lookup,
      backend: "brave",
      braveApiKey: FAKE_BRAVE_KEY,
    });

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "rust async" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("not_shipped"), err.message);
        assert.ok(err.message.includes("brave"), err.message);
        assert.ok(err.message.includes("v2"), err.message);
        // key 字面值绝不进 message（spec Assumption 6）。
        assert.ok(!err.message.includes(FAKE_BRAVE_KEY), err.message);
        return true;
      }
    );
  });

  it("handler with backend='brave' but no BRAVE_API_KEY → missing_key (precedes not_shipped)", async () => {
    // 边界：三态 fail-closed 在 handler entry 判定 —— `assertBackendConfig`
    // 在 backend=brave 但 braveApiKey 缺失时先抛 missing_key（typed
    // ToolExecutionError），**不**让 fetchResults 阶段的 not_shipped 漏出去。
    // 此断言钉「配置态错误优先于未实现态」，与 TavilyBackend 同形态。
    const fetch: GuardFetchFn = (() => undefined) as unknown as GuardFetchFn;
    const lookup: GuardLookupFn = async () => [];
    const deps: WebSearchToolDeps = { fetch, lookup, backend: "brave" };
    const tool = createWebSearchTool(deps);

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("missing_key"), err.message);
        // missing_key 不该含 v2 hint（未走到 fetchResults 阶段）。
        assert.ok(!err.message.includes("not_shipped"), err.message);
        assert.ok(!err.message.includes("v2"), err.message);
        return true;
      }
    );
  });
});
