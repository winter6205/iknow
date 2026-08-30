/**
 * TavilyBackend (#826 T5) — stub tests for the Tavily stub path.
 *
 * 覆盖契约（spec SC #8 + T5 acceptance criteria）：
 *   - basic: fixture JSON（`{results: [{title, content, url}]}`）→ Bing-shape
 *     `{title, snippet, url}`，`snippet = result.content`。
 *   - empty: `results: []` → 空数组（与 Bing 零结果同失败族，不 silent 改写）。
 *   - field-cap: 8 results + `maxResults=3` → 恰好 3 条；下游 shared cap
 *     （title ≤ 200 / snippet ≤ 500 / url ≤ 2000）由既有 `projectSearchResult`
 *     一刀切，adapter 不写自家 cap。
 *   - **result.answer ignore**（spec Assumption 8）：fixture 含 `result.answer`
 *     字段 → 断言 projected `snippet` **不**含 answer 字面值（且**不**进
 *     formatted output —— handler integration test 同形态断言）。
 *   - not_shipped: `BACKENDS.tavily(guardDeps, apiKey).fetchResults(...)` →
 *     typed `SearchBackendError(kind="not_shipped")`，message 含 backend id
 *     "tavily" + v2 提示。
 *
 * 注：本文件不测真 HTTP（v1 stub 不发请求）。opt-in real HTTP probe 走 T8。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../../../src/harness/errors.ts";
import {
  BACKENDS,
  createWebSearchTool,
  TavilyBackend,
  type WebSearchToolDeps,
} from "../../../../../../src/harness/aci/tools/web-search.ts";
import { isSearchBackendError } from "../../../../../../src/harness/aci/tools/web-search-errors.ts";
import type {
  GuardFetchFn,
  GuardLookupFn,
} from "../../../../../../src/harness/aci/tools/network-guard.ts";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_DOMAIN = "api.tavily.com";

/**
 * Tavily fixture 形态（spec Assumption 8）：`{results: [{title, content, url,
 * answer?}]}`。`answer` 是 Tavily 上游 LLM-synthesized 字段 —— spec 明文忽略。
 */
function tavilyFixtureResults(): Array<Record<string, unknown>> {
  return [
    {
      title: "Tavily Title 1",
      url: "https://site1.example.com/page",
      content: "Tavily Content 1 & more",
      // 故意混入 answer —— 验证 ignore 路径。
      answer: "some text that should never appear in output",
    },
    {
      title: "Tavily Title 2",
      url: "https://site2.example.com/page",
      content: "Tavily Content 2",
    },
    {
      title: "Tavily Title 3",
      url: "https://site3.example.com/page",
      // 无 content → snippet 空串（与 Bing path 同形态）。
      answer: "another ignored answer",
    },
  ];
}

describe("TavilyBackend — fetchResults (#826 T5)", () => {
  it("fetchResults throws typed not_shipped with 'tavily' in message and v2 hint", async () => {
    const backend = new TavilyBackend();

    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(
          isSearchBackendError(err),
          `expected typed SearchBackendError, got ${String(err)}`
        );
        assert.equal(err.kind, "not_shipped");
        assert.ok(err.message.includes("tavily"), err.message);
        // v2 hint: 提示等 v2 真 fetch 推进。
        assert.ok(err.message.includes("v2"), err.message);
        assert.equal(err.endpoint, TAVILY_DOMAIN);
        return true;
      }
    );
  });

  it("fetchResults is async and returns Promise<never>", () => {
    const backend = new TavilyBackend();
    const result = backend.fetchResults({ query: "x", maxResults: 5 });
    assert.ok(result instanceof Promise);
    return result.catch(() => {
      /* expected rejection */
    });
  });

  it("fetchResults does not surface any apiKey / Authorization in the message", async () => {
    const fakeKey = "tavily-secret-do-not-leak-0123456789";
    // v1 stub 不读 apiKey（无 constructor 参数），但 message 仍过
    // `createSearchBackendError` 的 redactAuthSecrets 兜底。验证 key 字面值
    // 不出现在 message 里 —— 与 ExaBackend 同形态（spec Assumption 6）。
    const backend = new TavilyBackend();
    void fakeKey; // 不传给 backend（v1 不读）；保留变量便于断言心智对齐。
    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.ok(!err.message.includes(fakeKey), err.message);
        assert.ok(!/bearer/i.test(err.message), err.message);
        assert.ok(!/authorization/i.test(err.message), err.message);
        return true;
      }
    );
  });
});

describe("TavilyBackend — project (#826 T5)", () => {
  const backend = new TavilyBackend();

  it("basic: 投影 Tavily JSON 到 Bing-shape {title, snippet, url}", () => {
    const out = backend.project(
      { results: tavilyFixtureResults() },
      10
    ) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Tavily Title 1");
    assert.equal(out[0].url, "https://site1.example.com/page");
    // spec Assumption 8: snippet 来自 result.content，不是 result.answer。
    assert.equal(out[0].snippet, "Tavily Content 1 & more");
    assert.equal(out[1].title, "Tavily Title 2");
    assert.equal(out[1].snippet, "Tavily Content 2");
    // 第三条无 content → 空串（与 Bing path 同形态）。
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
      content: `Content ${i + 1}`,
    }));
    const out = backend.project({ results: many }, 3) as Array<{
      title: string;
      snippet: string;
    }>;
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Title 1");
    assert.equal(out[2].title, "Title 3");
  });

  it("result.answer ignored: projected snippet 不含 answer 字面值", () => {
    // spec Assumption 8 明文：忽略 result.answer。fixture 含 answer 字段
    // → 断言 projected SearchResult[] 全字段（title / url / snippet）均不含
    // answer 字面值。snippet 必须来自 content，不是 answer。
    const answerText = "some text that should never appear in output";
    const raw = {
      results: [
        {
          title: "Tavily Title",
          url: "https://site.example.com/page",
          content: "Legitimate content",
          answer: answerText,
        },
      ],
    };
    const out = backend.project(raw, 10) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    assert.equal(out.length, 1);
    assert.equal(out[0].snippet, "Legitimate content");
    assert.ok(!out[0].snippet.includes(answerText));
    assert.ok(!out[0].title.includes(answerText));
    assert.ok(!out[0].url.includes(answerText));
  });

  it("parse: 非对象 raw → typed parse error (NOT silent empty array)", () => {
    const raw = "not an object";
    assert.throws(
      () => backend.project(raw, 10),
      (err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.kind, "parse");
        assert.equal(err.endpoint, TAVILY_DOMAIN);
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

  it("project: 单条 result 非对象 → 跳过（不抛错；同 Bing path 容错形态）", () => {
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

describe("TavilyBackend — describe (#826 T5)", () => {
  it("returns adapter='tavily' + latencyMs derived from startedAt", () => {
    const backend = new TavilyBackend();
    const startedAt = Date.now() - 25;
    const meta = backend.describe({ results: [] }, startedAt);
    assert.equal(meta.adapter, "tavily");
    assert.ok(
      meta.latencyMs >= 25,
      `latencyMs must reflect at least the gap to startedAt, got ${meta.latencyMs}`
    );
    assert.equal(meta.requestId, undefined);
  });

  it("describe does not throw typed not_shipped (unlike fetchResults)", () => {
    // #826 T5: describe / project 走真实现（不抛），仅 fetchResults 抛 typed
    // not_shipped。回归钉：避免后续改动误把 describe 也升级为 stub。
    const backend = new TavilyBackend();
    assert.doesNotThrow(() => backend.describe({ results: [] }, Date.now()));
  });
});

describe("TavilyBackend — handler integration (#826 T5)", () => {
  it("basic: handler returns Bing-shape formatted output using result.content (NOT answer)", async () => {
    // stub `fetchResults` 返 fixture（绕过 v1 stub 的 not_shipped），
    // 让 handler 集成测试走完整路径：fetchResults → project → format。
    const answerText = "some text that should never appear in output";
    const fixture = {
      results: [
        {
          title: "Tavily Title 1",
          url: "https://site1.example.com/page",
          content: "Tavily Content 1",
          answer: answerText,
        },
      ],
    };
    const tool = makeTavilyTool(fixture);

    const out = (await tool.handler({ query: "rust async" })) as string;

    assert.match(out, /^Search results for: rust async\n/);
    assert.match(out, /1\. Tavily Title 1/);
    assert.match(out, /URL: https:\/\/site1\.example\.com\/page/);
    // snippet 来自 content，不是 answer。
    assert.match(out, /Tavily Content 1/);
    // answer 字面值**绝**不出现在 formatted output 任何位置。
    assert.ok(
      !out.includes(answerText),
      `formatted output leaked result.answer text: ${out}`
    );
  });

  it("not_shipped: BACKENDS.tavily factory → fetchResults throws typed not_shipped", async () => {
    // T5 acceptance: 直接调 `BACKENDS.tavily(guardDeps, apiKey).fetchResults(...)`
    // → typed SearchBackendError(kind="not_shipped")。
    const factory = BACKENDS.tavily;
    const backend = factory({
      guardDeps: {
        fetch: (() => undefined) as unknown as GuardFetchFn,
        lookup: async () => [],
      },
      endpoint: "https://example.invalid",
      apiKey: "fake-tavily-key",
    });
    assert.ok(backend instanceof TavilyBackend);
    assert.equal(backend.id, "tavily");

    await assert.rejects(
      () => backend.fetchResults({ query: "x", maxResults: 5 }),
      (err: unknown) => {
        assert.ok(
          isSearchBackendError(err),
          `expected typed SearchBackendError, got ${String(err)}`
        );
        assert.equal(err.kind, "not_shipped");
        assert.ok(err.message.includes("tavily"), err.message);
        assert.equal(err.endpoint, TAVILY_DOMAIN);
        return true;
      }
    );
  });

  it("not_shipped: handler exits with typed not_shipped ToolExecutionError", async () => {
    // 端到端：BACKENDS.tavily 工厂 → handler 出口 1:1 转译为 ToolExecutionError。
    // 这是 spec SC #8 的契约：被选中时抛 typed not_shipped。
    const tool = createWebSearchTool({
      fetch: (() => undefined) as unknown as GuardFetchFn,
      lookup: async () => [],
      backend: "tavily",
      tavilyApiKey: "fake-tavily-key",
    });

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("not_shipped"), err.message);
        assert.ok(err.message.includes("tavily"), err.message);
        assert.ok(err.message.includes("v2"), err.message);
        return true;
      }
    );
  });

  it("BACKENDS.tavily factory yields a real TavilyBackend (T5 lands)", () => {
    // 验证 BACKENDS.tavily 是真工厂（不再是 placeholder）—— T5 落地后
    // BACKENDS.tavily 返 TavilyBackend 实例，T6 落地 brave 后此 assertion
    // 同样适用 brave。
    const factory = BACKENDS.tavily;
    const instance = factory({
      guardDeps: {
        fetch: (() => undefined) as unknown as GuardFetchFn,
        lookup: async () => [],
      },
      endpoint: "https://example.invalid",
    });
    assert.ok(instance instanceof TavilyBackend);
    assert.equal(instance.id, "tavily");
  });

  it("TavilyEndpoint constant: TAVILY_ENDPOINT matches the documented vendor URL", () => {
    // 钉死 endpoint 常量值 —— 防 T2/T4/T5 重构时不小心改写 url。
    // 当前未 export，本测试通过 fetchResults 错误 message 间接断言（endpoint
    // 收窄到 api.tavily.com 域名）。
    const backend = new TavilyBackend();
    void backend
      .fetchResults({ query: "x", maxResults: 5 })
      .catch((err: unknown) => {
        assert.ok(isSearchBackendError(err));
        assert.equal(err.endpoint, TAVILY_DOMAIN);
        // URL 形态：api.tavily.com/search（Tavily 真端点）。
        assert.equal(err.endpoint, new URL(TAVILY_ENDPOINT).hostname);
      });
  });
});

/**
 * helper：构造 handler 集成测试用的 tool。`backendFactory` 注入 stub
 * backend —— stub `fetchResults` 返 fixture，stub `project` 走真
 * TavilyBackend.project（保留 spec Assumption 8 的投影契约）。
 */
function makeTavilyTool(
  fixture: unknown
): ReturnType<typeof createWebSearchTool> {
  const dummyFetch = (() => undefined) as unknown as GuardFetchFn;
  const lookup: GuardLookupFn = async () => [];
  const deps: WebSearchToolDeps = {
    fetch: dummyFetch,
    lookup,
    backend: "tavily",
    tavilyApiKey: "fake-tavily-key",
    backendFactory: () => ({
      id: "tavily" as const,
      fetchResults: async () => fixture,
      project: (raw: unknown, maxResults: number) =>
        // 走真 TavilyBackend.project —— 验证 BACKENDS.tavily 工厂路径的
        // 投影形态字节级一致。
        new TavilyBackend().project(raw, maxResults),
      describe: (raw: unknown, startedAt: number) => ({
        adapter: "tavily" as const,
        latencyMs: Date.now() - startedAt,
      }),
    }),
  };
  return createWebSearchTool(deps);
}
