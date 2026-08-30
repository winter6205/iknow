/**
 * ExaBackend (#826 T4) — stub fetch tests for the Exa 真 HTTP path.
 *
 * 覆盖契约（spec SC #3 衍生 + T4 acceptance criteria）：
 *   - basic: fixture JSON（`{ results: [{title, highlights, text, url}] }`）→
 *     Bing-shape `{title, snippet, url}`，`snippet = highlights[0].text ?? text ?? ""`。
 *   - empty: `results: []` → 空数组（与 Bing 零结果同失败族，不 silent 改写）。
 *   - field-cap: 8 results + `maxResults=3` → 恰好 3 条；下游 shared cap
 *     （title ≤ 200 / snippet ≤ 500 / url ≤ 2000）由既有 `projectSearchResult`
 *     一刀切，adapter 不写自家 cap。
 *   - parse: 畸形 JSON / 畸形 result 形态 → typed
 *     `SearchBackendError(kind="parse")`，**不** silent empty。
 *   - non-2xx: 401 / 429 / 5xx 三 fixture；message 含 upstream status + endpoint
 *     域名；**绝不**含 key 字面值 / "Bearer" / "Authorization"。
 *   - timeout: AbortController + 抛 `AbortError` 的 stub fetch →
 *     typed `SearchBackendError(kind="timeout")`。
 *
 * 注：本文件只 stub fetch；opt-in real HTTP probe 走 T8。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../../../src/harness/errors.ts";
import {
  BACKENDS,
  createWebSearchTool,
  ExaBackend,
  type SearchBackend,
  type WebSearchToolDeps,
} from "../../../../../../src/harness/aci/tools/web-search.ts";
import { isSearchBackendError } from "../../../../../../src/harness/aci/tools/web-search-errors.ts";
import type { GuardFetchFn } from "../../../../../../src/harness/aci/tools/network-guard.ts";

const EXA_ENDPOINT = "https://api.exa.ai/search";
const EXA_DOMAIN = "api.exa.ai";

/** 假 Exa API key — 任何 error message 都不应包含此字面值。 */
const FAKE_EXA_KEY = "exa-secret-do-not-leak-0123456789";

/**
 * Stub fetch 函数工厂：返回 `(status, body)` 配置的 fetch，断言抓到的
 * URL / headers 形态（验证 `Authorization: Bearer` + POST + JSON body）。
 */
function makeExaFetch(args: {
  status: number;
  body: string;
  /** 模拟 fetch 抛 AbortError 而非返 response。 */
  throwAbort?: boolean;
}): {
  fetch: typeof globalThis.fetch;
  seen: () => Array<{
    url: string;
    init: RequestInit;
  }>;
} {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: typeof globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (args.throwAbort) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Response(args.body, {
      status: args.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetchFn, seen: () => seen };
}

/** 直接构造 ExaBackend（注入 stub fetch）。 */
function makeExaBackend(
  fetchFn: typeof globalThis.fetch,
  apiKey = FAKE_EXA_KEY
): ExaBackend {
  return new ExaBackend({ apiKey, fetch: fetchFn });
}

/** Exa fixture: highlights 优先于 text。 */
function exaFixtureResults(): Array<Record<string, unknown>> {
  return [
    {
      title: "Exa Title 1",
      url: "https://site1.example.com/page",
      highlights: [{ text: "Highlight 1" }],
      text: "Body text 1",
    },
    {
      title: "Exa Title 2",
      url: "https://site2.example.com/page",
      // 无 highlights，应落 text 字段。
      text: "Body text 2",
    },
    {
      title: "Exa Title 3",
      url: "https://site3.example.com/page",
      // 既无 highlights 也无 text → snippet 空串。
    },
  ];
}

describe("ExaBackend — fetchResults (#826 T4)", () => {
  it("posts to api.exa.ai with Authorization Bearer + JSON body", async () => {
    const { fetch: stubFetch, seen } = makeExaFetch({
      status: 200,
      body: JSON.stringify({ results: exaFixtureResults() }),
    });
    const backend = makeExaBackend(stubFetch);

    const raw = await backend.fetchResults({
      query: "rust async",
      maxResults: 5,
    });

    const calls = seen();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, EXA_ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, `Bearer ${FAKE_EXA_KEY}`);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.query, "rust async");
    assert.equal(body.numResults, 5);
    assert.equal(body.contents.highlights, true);
    assert.ok(raw && typeof raw === "object");
  });

  it.each([401, 429, 503])(
    "non-2xx status=%i → typed http_non_2xx naming status + endpoint domain, no key leak",
    async (status) => {
      const { fetch: stubFetch } = makeExaFetch({
        status,
        body: JSON.stringify({ error: "boom" }),
      });
      const backend = makeExaBackend(stubFetch);

      await assert.rejects(
        () => backend.fetchResults({ query: "x", maxResults: 5 }),
        (err: unknown) => {
          assert.ok(
            isSearchBackendError(err),
            `expected typed SearchBackendError, got ${String(err)}`
          );
          assert.equal(err.kind, "http_non_2xx");
          assert.ok(err.message.includes(String(status)), err.message);
          assert.equal(err.endpoint, EXA_DOMAIN);
          // key / Authorization / Bearer 必须不出现在 message 里。
          assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
          assert.ok(!/bearer/i.test(err.message), err.message);
          assert.ok(!/authorization/i.test(err.message), err.message);
          return true;
        }
      );
    }
  );

  it("timeout → typed timeout error when fetch throws AbortError", async () => {
    const { fetch: stubFetch } = makeExaFetch({
      status: 200,
      body: "",
      throwAbort: true,
    });
    const backend = makeExaBackend(stubFetch);

    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "timeout");
        assert.equal(err.endpoint, EXA_DOMAIN);
        // 同 http_non_2xx：key / Authorization 不该出现在 timeout message 里。
        assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
        assert.ok(!/bearer/i.test(err.message), err.message);
        assert.ok(!/authorization/i.test(err.message), err.message);
        return true;
      }
    );
  });

  it("timeout → typed timeout error when signal aborted (caller-side)", async () => {
    const controller = new AbortController();
    const fetchFn: typeof globalThis.fetch = async (_url, init) => {
      // 测 caller-side signal.aborted（fetch 还没走到 response）。
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const backend = new ExaBackend({ apiKey: FAKE_EXA_KEY, fetch: fetchFn });

    await assert.rejects(
      () =>
        backend.fetchResults({
          query: "x",
          maxResults: 5,
          signal: controller.signal,
        }),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "timeout");
        return true;
      }
    );
  });

  it("parse: malformed JSON body → typed parse error, NOT silent empty", async () => {
    const { fetch: stubFetch } = makeExaFetch({
      status: 200,
      body: "not json {{{",
    });
    const backend = makeExaBackend(stubFetch);

    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "parse");
        assert.equal(err.endpoint, EXA_DOMAIN);
        return true;
      }
    );
  });

  it("refuses empty apiKey (defends against direct-construction path)", () => {
    assert.throws(
      () => new ExaBackend({ apiKey: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.message.includes("apiKey")
    );
  });

  it("uses globalThis.fetch by default when no fetch override is supplied", async () => {
    // 仅验证构造不抛错 + 暴露的 fetch 路径（不实际打网络）。
    const backend = new ExaBackend({ apiKey: FAKE_EXA_KEY });
    assert.equal(backend.id, "exa");
  });
});

describe("ExaBackend — project (#826 T4)", () => {
  const backend = new ExaBackend({
    apiKey: FAKE_EXA_KEY,
    fetch: (() => undefined) as unknown as typeof globalThis.fetch,
  });

  it("basic: highlights[0].text 优先于 text", () => {
    const out = backend.project({ results: exaFixtureResults() }, 10) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Exa Title 1");
    assert.equal(out[0].url, "https://site1.example.com/page");
    assert.equal(out[0].snippet, "Highlight 1");
    // 第二条无 highlights，落 text。
    assert.equal(out[1].snippet, "Body text 2");
    // 第三条都无 → 空串（与 Bing path 同形态，由 projectSearchResult 兜底）。
    assert.equal(out[2].snippet, "");
  });

  it("empty: results=[] → empty array (matches Bing zero-result behavior)", () => {
    const out = backend.project({ results: [] }, 10) as unknown[];
    assert.deepEqual(out, []);
  });

  it("field-cap: 8 results + maxResults=3 → 恰好 3 条", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `Title ${i + 1}`,
      url: `https://site${i + 1}.example.com/page`,
      highlights: [{ text: `Snippet ${i + 1}` }],
    }));
    const out = backend.project({ results: many }, 3) as Array<{
      title: string;
      snippet: string;
    }>;
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Title 1");
    assert.equal(out[2].title, "Title 3");
  });

  it("parse: 非对象 raw → typed parse error (NOT silent empty array)", () => {
    const raw = "not an object";
    assert.throws(
      () => backend.project(raw, 10),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "parse");
        assert.equal(err.endpoint, EXA_DOMAIN);
        return true;
      }
    );
  });

  it("parse: results 字段缺位 → typed parse error", () => {
    const raw = { foo: "bar" };
    assert.throws(
      () => backend.project(raw, 10),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "parse");
        return true;
      }
    );
  });

  it("project: 单条 result 非对象 → 跳过（不抛错；同 field-cap 路径）", () => {
    const raw = { results: ["not-an-object", null, 42] };
    const out = backend.project(raw, 10) as unknown[];
    assert.deepEqual(out, []);
  });

  it("project: 单条 result 全字段缺失 → 被 projectSearchResult 丢弃", () => {
    const raw = { results: [{ foo: "bar" }] };
    const out = backend.project(raw, 10) as unknown[];
    assert.deepEqual(out, []);
  });
});

describe("ExaBackend — describe (#826 T4)", () => {
  it("returns adapter='exa' + latencyMs derived from startedAt", () => {
    const backend = new ExaBackend({
      apiKey: FAKE_EXA_KEY,
      fetch: (() => undefined) as unknown as typeof globalThis.fetch,
    });
    const startedAt = Date.now() - 25;
    const meta = backend.describe({ results: [] }, startedAt);
    assert.equal(meta.adapter, "exa");
    assert.ok(
      meta.latencyMs >= 25,
      `latencyMs must reflect at least the gap to startedAt, got ${meta.latencyMs}`
    );
    assert.equal(meta.requestId, undefined);
  });
});

describe("ExaBackend — handler integration (#826 T4)", () => {
  it("basic: handler returns Bing-shape formatted output with highlights snippet", async () => {
    const { fetch: stubFetch } = makeExaFetch({
      status: 200,
      body: JSON.stringify({ results: exaFixtureResults() }),
    });
    const tool = makeExaTool(stubFetch);

    const out = (await tool.handler({ query: "rust async" })) as string;
    assert.match(out, /^Search results for: rust async\n/);
    assert.match(out, /1\. Exa Title 1/);
    assert.match(out, /URL: https:\/\/site1\.example\.com\/page/);
    assert.match(out, /Highlight 1/);
    assert.match(out, /2\. Exa Title 2/);
    assert.match(out, /Body text 2/);
  });

  it("empty results: handler surfaces 'No search results' ToolExecutionError", async () => {
    const { fetch: stubFetch } = makeExaFetch({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    const tool = makeExaTool(stubFetch);

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "nothing" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("No search results"));
        return true;
      }
    );
  });

  it("non-2xx: handler exits with typed http_non_2xx ToolExecutionError", async () => {
    const { fetch: stubFetch } = makeExaFetch({
      status: 503,
      body: JSON.stringify({ error: "down" }),
    });
    const tool = makeExaTool(stubFetch);

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("http_non_2xx"), err.message);
        assert.ok(err.message.includes("503"), err.message);
        assert.ok(err.message.includes(EXA_DOMAIN), err.message);
        assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
        return true;
      }
    );
  });

  it("BACKENDS.exa factory wires through to ExaBackend (constructor shape)", () => {
    // 验证 BACKENDS.exa 是真工厂 + 透传 apiKey —— 让 T7 integration test
    // 走真 loader 时能拿到非占位 ExaBackend 实例。
    const factory = BACKENDS.exa;
    assert.equal(typeof factory, "function");
    const instance = factory({
      guardDeps: {
        fetch: (() => undefined) as unknown as GuardFetchFn,
        lookup: async () => [],
      },
      endpoint: "https://example.invalid",
      apiKey: FAKE_EXA_KEY,
    });
    assert.ok(instance instanceof ExaBackend);
    assert.equal(instance.id, "exa");
  });

  it("BACKENDS.exa without apiKey produces an ExaBackend that refuses to fetch", async () => {
    // 边界：apiKey 缺失（绕过 handler entry 校验）→ 构造函数抛
    // ToolExecutionError，handler 永远拿不到可用实例。
    const factory = BACKENDS.exa;
    assert.throws(
      () =>
        factory({
          guardDeps: {
            fetch: (() => undefined) as unknown as GuardFetchFn,
            lookup: async () => [],
          },
          endpoint: "https://example.invalid",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.message.includes("apiKey")
    );
  });
});

/**
 * helper：构造 handler 集成测试用的 tool。注入 stub fetch（直接挂到
 * ExaBackend 实例），绕过 BACKENDS.exa 走 backendFactory 注入路径。
 */
function makeExaTool(
  stubFetch: typeof globalThis.fetch
): ReturnType<typeof createWebSearchTool> {
  // dummy fetch（不走到；ExaBackend 走自己的 stub）
  const fetch: GuardFetchFn = (() => undefined) as unknown as GuardFetchFn;
  const lookup: GuardLookupFn = async () => [];
  const deps: WebSearchToolDeps = {
    fetch,
    lookup,
    backend: "exa",
    exaApiKey: FAKE_EXA_KEY,
    backendFactory: () =>
      new ExaBackend({ apiKey: FAKE_EXA_KEY, fetch: stubFetch }),
  };
  return createWebSearchTool(deps);
}
