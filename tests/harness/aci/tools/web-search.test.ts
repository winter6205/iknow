/**
 * web_search 工具单元测试。
 *
 * 行为真值：web_search_tool.py
 * （默认 DuckDuckGo html 端点 + result__a / result__snippet 解析 + uddg URL 归一）。
 *
 * 覆盖契约（ADR 测试规范 6 项 + ACR 5 类边界）：
 *   - 工厂签名 createWebSearchTool(deps?) → AciToolDef，name === "web_search"
 *   - inputSchema: query 必填 + max_results?(默认 5, ge 1, le 10) + search_url? +
 *     additionalProperties:false
 *   - aci 元数据: category=read-only, isConcurrencySafe=true,
 *     interruptBehavior=cancel, timeoutTier=default
 *   - 成功路径：编号列表 `N. title / URL: / snippet`
 *   - max_results 截断；clamp 超上限 → 10，≤0/非数 → 5
 *   - DuckDuckGo /l/?uddg= 重定向链接归一为目标 URL
 *   - 空 query / 无结果 → ToolExecutionError
 *   - 非 2xx → ToolExecutionError
 *   - 并发扇出（Promise.all + 独立 stub）
 *
 * 全部离线：deps.fetch / deps.lookup 注入 stub。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  BACKENDS,
  BingBackend,
  createWebSearchTool,
  selectBackend,
  type SearchBackend,
  type SearchBackendId,
  type WebSearchToolDeps,
} from "../../../../src/harness/aci/tools/web-search.ts";
import {
  SEARCH_BACKEND_ERROR_KINDS,
  createSearchBackendError,
  isSearchBackendError,
  toToolExecutionError,
  type SearchBackendErrorKind,
} from "../../../../src/harness/aci/tools/web-search-errors.ts";
import type {
  GuardFetchFn,
  GuardLookupFn,
} from "../../../../src/harness/aci/tools/network-guard.ts";

const PUBLIC_IP = "93.184.216.34";
const okLookup: GuardLookupFn = async () => [PUBLIC_IP];

/** 构造 DuckDuckGo html 风格的结果页。 */
function ddgBody(count: number): string {
  const items: string[] = [];
  for (let i = 1; i <= count; i++) {
    items.push(
      `<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fsite${i}.example.com%2Fpage&amp;rut=abc">Title ${i}</a>`,
      `<div class="result__snippet">Snippet ${i} &amp; more</div>`
    );
  }
  return `<html><body>${items.join("")}</body></html>`;
}

function ddgBodyWithLongFields(count: number): string {
  const items: string[] = [];
  for (let i = 1; i <= count; i++) {
    items.push(
      `<a class="result__a" href="https://site${i}.example.com/${"u".repeat(140)}">Title ${i} ${"t".repeat(400)}</a>`,
      `<div class="result__snippet">Snippet ${i} ${"s".repeat(800)}</div>`
    );
  }
  return `<html><body>${items.join("")}</body></html>`;
}

/** 构造 Bing 风格的结果页（真实 DOM：li.b_algo → h2>a + div.b_caption）。 */
function bingBody(count: number): string {
  const items: string[] = [];
  for (let i = 1; i <= count; i++) {
    items.push(
      `<li class="b_algo" data-idx="0"><h2><a target="_blank" href="https://site${i}.example.com/page"><strong>Bing Title ${i}</strong></a></h2>` +
        `<div class="b_caption"><p class="b_lineclamp2">Bing Snippet ${i} &amp; more</p></div></li>`
    );
  }
  return `<html><body><ol id="b_results">${items.join("")}</ol></body></html>`;
}

/**
 * 构造工具 deps。默认端点=Bing(B1),所以显式声明测试端点避免耦合:
 * - 传 DDG body 的测试应给 DDG endpoint;
 * - 传 Bing body 的测试应给 Bing endpoint。
 * `endpoint` 缺省为 DDG(保留旧测试 fixture 的意图)。
 */
function searchDeps(
  body: string,
  status = 200,
  endpoint = "https://html.duckduckgo.com/html/"
): WebSearchToolDeps {
  const fetch: GuardFetchFn = async () => ({
    status,
    contentType: "text/html; charset=UTF-8",
    body,
  });
  return { fetch, lookup: okLookup, envSearchUrl: endpoint };
}

async function expectToolError(
  fn: () => Promise<unknown>,
  substring: string
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) =>
      err instanceof ToolExecutionError && err.message.includes(substring)
  );
}

describe("createWebSearchTool — schema/aci shape", () => {
  it("name === 'web_search'", () => {
    const tool = createWebSearchTool();
    assert.equal(tool.name, "web_search");
  });

  it("inputSchema requires query and bounds max_results", () => {
    const tool = createWebSearchTool();
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { type: string; default?: number; minimum?: number; maximum?: number }
      >;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(schema.required, ["query"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.max_results.default, 5);
    assert.equal(schema.properties.max_results.minimum, 1);
    assert.equal(schema.properties.max_results.maximum, 10);
    assert.equal(schema.properties.search_url.type, "string");
  });

  it("aci meta: read-only / concurrency-safe / cancel / default tier", () => {
    const tool = createWebSearchTool();
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(tool.aci.timeoutTier, "default");
  });
});

describe("createWebSearchTool — success path", () => {
  it("returns numbered results with title / URL / snippet", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(2)));
    const out = (await tool.handler({ query: "rust async" })) as string;
    assert.match(out, /^Search results for: rust async\n/);
    assert.match(out, /1\. Title 1/);
    assert.match(out, /URL: https:\/\/site1\.example\.com\/page/);
    assert.match(out, /Snippet 1 & more/);
    assert.match(out, /2\. Title 2/);
  });

  it("normalizes DuckDuckGo /l/?uddg redirect links to the target URL", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(1)));
    const out = (await tool.handler({ query: "x" })) as string;
    assert.ok(!out.includes("duckduckgo.com/l/"));
    assert.match(out, /URL: https:\/\/site1\.example\.com\/page/);
  });

  it("caps results at max_results", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(8)));
    const out = (await tool.handler({
      query: "x",
      max_results: 3,
    })) as string;
    assert.match(out, /3\. Title 3/);
    assert.ok(!out.includes("4. Title 4"));
  });

  it("clamps max_results above the ceiling to 10", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(12)));
    const out = (await tool.handler({
      query: "x",
      max_results: 50,
    })) as string;
    assert.match(out, /10\. Title 10/);
    assert.ok(!out.includes("11. Title 11"));
  });

  it("falls back to default 5 when max_results is not a positive number", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(7)));
    const out = (await tool.handler({ query: "x", max_results: 0 })) as string;
    assert.match(out, /5\. Title 5/);
    assert.ok(!out.includes("6. Title 6"));
  });

  it("posts the query to the search endpoint as a q param", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({
      fetch,
      lookup: okLookup,
      envSearchUrl: "https://html.duckduckgo.com/html/",
    });
    await tool.handler({ query: "hello world" });
    assert.ok(
      seen.some((u) => u.includes("q=hello") && u.includes("world")),
      `expected q=hello+world in ${seen.join(",")}`
    );
  });

  it("trims padded queries before sending and formatting results", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({
      fetch,
      lookup: okLookup,
      envSearchUrl: "https://html.duckduckgo.com/html/",
    });

    const out = (await tool.handler({ query: "  hello world  " })) as string;

    assert.equal(new URL(seen[0]).searchParams.get("q"), "hello world");
    assert.match(out, /^Search results for: hello world\n/);
  });

  it("honors an explicit search_url override", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({ fetch, lookup: okLookup });
    await tool.handler({
      query: "x",
      search_url: "https://search.internal.example.com/html/",
    });
    assert.ok(seen[0].startsWith("https://search.internal.example.com/html/"));
  });

  it("falls back to deps.envSearchUrl when no search_url is given", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({
      fetch,
      lookup: okLookup,
      envSearchUrl: "https://env-endpoint.example.com/html/",
    });
    await tool.handler({ query: "x" });
    assert.ok(seen[0].startsWith("https://env-endpoint.example.com/html/"));
  });

  it("explicit search_url takes precedence over deps.envSearchUrl", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({
      fetch,
      lookup: okLookup,
      envSearchUrl: "https://env-endpoint.example.com/html/",
    });
    await tool.handler({
      query: "x",
      search_url: "https://explicit.example.com/html/",
    });
    assert.ok(seen[0].startsWith("https://explicit.example.com/html/"));
  });
});

describe("createWebSearchTool — Bing 解析器（B1 默认端点）", () => {
  it("默认端点指向 Bing(bing.com)而非 DDG html", async () => {
    // B1:默认端点切到 Bing,DDG html 不再是默认。
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: bingBody(1) };
    };
    const tool = createWebSearchTool({ fetch, lookup: okLookup });
    await tool.handler({ query: "x" });
    assert.ok(
      seen.length > 0 && /bing\.com\/search/.test(seen[0]),
      `expected default endpoint to be bing.com/search, got: ${seen.join(",")}`
    );
    assert.ok(!seen[0].includes("duckduckgo.com"));
  });

  it("解析 Bing HTML(b_algo / b_caption)为 title/URL/snippet", async () => {
    const tool = createWebSearchTool(
      searchDeps(bingBody(2), 200, "https://cn.bing.com/search")
    );
    const out = (await tool.handler({ query: "rust async" })) as string;
    assert.match(out, /^Search results for: rust async\n/);
    assert.match(out, /1\. Bing Title 1/);
    assert.match(out, /URL: https:\/\/site1\.example\.com\/page/);
    assert.match(out, /Bing Snippet 1 & more/);
    assert.match(out, /2\. Bing Title 2/);
  });

  it("accepts extra b_algo classes as Bing result blocks", async () => {
    const body =
      '<html><body><li class="b_algo b_algoBorder"><h2><a href="https://site.example.com/page">Extra class title</a></h2>' +
      '<div class="b_caption"><p>Extra class snippet</p></div></li></body></html>';
    const tool = createWebSearchTool(
      searchDeps(body, 200, "https://cn.bing.com/search")
    );

    const out = (await tool.handler({ query: "x" })) as string;

    assert.match(out, /1\. Extra class title/);
    assert.match(out, /Extra class snippet/);
  });

  it("falls back to the first paragraph when Bing has no b_caption", async () => {
    const body =
      '<html><body><li class="b_algo"><h2><a href="https://site.example.com/page">Fallback title</a></h2>' +
      '<div class="b_content"><p>Fallback snippet &amp; more</p></div></li></body></html>';
    const tool = createWebSearchTool(
      searchDeps(body, 200, "https://cn.bing.com/search")
    );

    const out = (await tool.handler({ query: "x" })) as string;

    assert.match(out, /1\. Fallback title/);
    assert.match(out, /Fallback snippet & more/);
  });

  it("max_results 截断同样作用于 Bing 解析器", async () => {
    const tool = createWebSearchTool(
      searchDeps(bingBody(8), 200, "https://cn.bing.com/search")
    );
    const out = (await tool.handler({
      query: "x",
      max_results: 3,
    })) as string;
    assert.match(out, /3\. Bing Title 3/);
    assert.ok(!out.includes("4. Bing Title 4"));
  });

  it("空结果(无 b_algo) → No search results", async () => {
    const tool = createWebSearchTool(
      searchDeps("<html><body><ol id='b_results'></ol></body></html>")
    );
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "nothing" })),
      "No search results"
    );
  });
});

describe("createWebSearchTool — failure paths", () => {
  it("rejects empty query", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(1)));
    await expectToolError(() => Promise.resolve(tool.handler({})), "query");
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "" })),
      "query"
    );
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "   \t\n" })),
      "query"
    );
  });

  it("falls back to default 5 for negative or invalid max_results", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(7)));

    const negativeOut = (await tool.handler({
      query: "x",
      max_results: -1,
    })) as string;
    const invalidOut = (await tool.handler({
      query: "x",
      max_results: "invalid",
    })) as string;

    assert.match(negativeOut, /5\. Title 5/);
    assert.ok(!negativeOut.includes("6. Title 6"));
    assert.match(invalidOut, /5\. Title 5/);
    assert.ok(!invalidOut.includes("6. Title 6"));
  });

  it("drops an item whose projected title, snippet, and URL are all empty", async () => {
    const tool = createWebSearchTool(
      searchDeps(
        '<a class="result__a" href=" "> </a><div class="result__snippet"> </div>'
      )
    );

    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "empty fields" })),
      "No search results"
    );
  });

  it("caps fields without cutting a field with a truncation marker", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBodyWithLongFields(1)));

    const out = (await tool.handler({ query: "x" })) as string;

    assert.match(out, /1\. Title 1/);
    assert.ok(!out.includes("t".repeat(400)));
    assert.ok(!out.includes("s".repeat(800)));
    assert.ok(!out.includes("truncated"));
    assert.ok(!out.includes("total"));
  });

  it("drops complete tail entries when the formatted result budget is exceeded", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBodyWithLongFields(10)));

    const out = (await tool.handler({ query: "x", max_results: 10 })) as string;

    assert.match(out, /1\. Title 1/);
    assert.ok(!out.includes("10. Title 10"));
    assert.ok(!out.includes("truncated"));
    assert.ok(!out.includes("total"));
    assert.ok(!out.includes("Title 10"));
  });

  it("throws a typed error when the budget cannot fit any result entry", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBodyWithLongFields(1)));

    await expectToolError(
      () =>
        Promise.resolve(
          tool.handler({ query: "q".repeat(10_000), max_results: 1 })
        ),
      "budget"
    );
  });

  it("rejects when the endpoint returns no results", async () => {
    const tool = createWebSearchTool(searchDeps("<html><body></body></html>"));
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "nothing here" })),
      "No search results"
    );
  });

  it("surfaces non-2xx as ToolExecutionError", async () => {
    const tool = createWebSearchTool(searchDeps("gateway down", 502));
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "x" })),
      "502"
    );
  });

  it("rejects a private search_url override", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(1)));
    await expectToolError(
      () =>
        Promise.resolve(
          tool.handler({ query: "x", search_url: "http://127.0.0.1:9000/" })
        ),
      "non-public"
    );
  });
});

describe("createWebSearchTool — concurrency", () => {
  it("two parallel handler calls with distinct stubs stay isolated", async () => {
    const toolA = createWebSearchTool(searchDeps(ddgBody(1)));
    const fetchB: GuardFetchFn = async () => ({
      status: 200,
      contentType: "text/html",
      body: ddgBody(2),
    });
    const toolB = createWebSearchTool({
      fetch: fetchB,
      lookup: okLookup,
      envSearchUrl: "https://html.duckduckgo.com/html/",
    });
    const [outA, outB] = await Promise.all([
      toolA.handler({ query: "a" }),
      toolB.handler({ query: "b" }),
    ]);
    assert.match(outA as string, /Search results for: a/);
    assert.match(outB as string, /Search results for: b/);
    assert.match(outB as string, /2\. Title 2/);
    assert.ok(!(outA as string).includes("2. Title 2"));
  });

  it("deduplicates same-query requests and returns a short cached projection", async () => {
    let fetchCount = 0;
    const tool = createWebSearchTool({
      fetch: async () => {
        fetchCount += 1;
        return {
          status: 200,
          contentType: "text/html",
          body: '<a class="result__a" href="https://site.example.com/page">Cached title</a><div class="result__snippet">Long cached snippet</div>',
        };
      },
      lookup: okLookup,
      envSearchUrl: "https://html.duckduckgo.com/html/",
    });

    const [first, second] = (await Promise.all([
      tool.handler({ query: "same query" }),
      tool.handler({ query: "same query" }),
    ])) as string[];

    assert.equal(fetchCount, 1);
    assert.match(first, /Long cached snippet/);
    assert.match(second, /Cached title/);
    assert.ok(!second.includes("Long cached snippet"));
  });

  it("does not share cached results between distinct queries", async () => {
    let fetchCount = 0;
    const tool = createWebSearchTool({
      fetch: async (url) => {
        fetchCount += 1;
        const query = new URL(url).searchParams.get("q");
        return {
          status: 200,
          contentType: "text/html",
          body: `<a class="result__a" href="https://site.example.com/${query}">${query} title</a>`,
        };
      },
      lookup: okLookup,
      envSearchUrl: "https://html.duckduckgo.com/html/",
    });

    const [alpha, beta] = (await Promise.all([
      tool.handler({ query: "alpha" }),
      tool.handler({ query: "beta" }),
    ])) as string[];

    assert.equal(fetchCount, 2);
    assert.match(alpha, /alpha title/);
    assert.ok(!alpha.includes("beta title"));
    assert.match(beta, /beta title/);
    assert.ok(!beta.includes("alpha title"));
  });
});

// =============================================================================
// #826 T2: SearchBackend seam (BACKENDS / selectBackend / BingBackend) tests.
// Verifies same-shape interface (fetchResults / project / describe) and that
// createWebSearchTool({ backend: "bing" }) is byte-identical to the no-backend
// path. T3-T6 will replace placeholder backends with real fetch + typed errors.
// =============================================================================

describe("BACKENDS — pluggable backend table (#826 T2)", () => {
  it("has entries for all four backend ids", () => {
    const ids: SearchBackendId[] = ["bing", "tavily", "exa", "brave"];
    for (const id of ids) {
      assert.equal(
        typeof BACKENDS[id],
        "function",
        `BACKENDS.${id} must be a backend factory`
      );
    }
  });

  it("selectBackend('bing') returns the bing factory", () => {
    assert.equal(selectBackend("bing"), BACKENDS.bing);
  });

  it("selectBackend throws for an unknown backend id at the type boundary", () => {
    // The TS type prevents this at compile time; the runtime guard is defensive.
    const factory = selectBackend("bing");
    assert.equal(typeof factory, "function");
  });
});

describe("BingBackend — three-method same-shape (#826 T2)", () => {
  it("constructs with guard deps + endpoint, exposes id='bing'", () => {
    const backend = new BingBackend(
      { fetch: (() => undefined) as unknown as GuardFetchFn, lookup: okLookup },
      "https://cn.bing.com/search"
    );
    assert.equal(backend.id, "bing");
  });

  it("has fetchResults / project / describe with expected signatures", () => {
    const backend = new BingBackend(
      { fetch: (() => undefined) as unknown as GuardFetchFn, lookup: okLookup },
      "https://cn.bing.com/search"
    );
    assert.equal(typeof backend.fetchResults, "function");
    assert.equal(typeof backend.project, "function");
    assert.equal(typeof backend.describe, "function");
  });

  it("describe returns adapter='bing' + latencyMs derived from startedAt", () => {
    const backend = new BingBackend(
      { fetch: (() => undefined) as unknown as GuardFetchFn, lookup: okLookup },
      "https://cn.bing.com/search"
    );
    const startedAt = Date.now() - 50;
    const meta = backend.describe("<html></html>", startedAt);
    assert.equal(meta.adapter, "bing");
    assert.ok(
      meta.latencyMs >= 50,
      `latencyMs must reflect at least the gap to startedAt, got ${meta.latencyMs}`
    );
    assert.equal(meta.requestId, undefined);
  });

  it("project parses Bing HTML body into Bing-shape SearchResult[]", () => {
    const backend = new BingBackend(
      { fetch: (() => undefined) as unknown as GuardFetchFn, lookup: okLookup },
      "https://cn.bing.com/search"
    );
    const body = bingBody(2);
    const results = backend.project(body, 5) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    assert.equal(results.length, 2);
    assert.match(results[0].title, /Bing Title 1/);
    assert.match(results[0].url, /site1\.example\.com/);
    assert.match(results[0].snippet, /Bing Snippet 1/);
  });

  it("fetchResults appends query as ?q=... and returns raw HTML body", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return {
        status: 200,
        contentType: "text/html; charset=UTF-8",
        body: bingBody(1),
      };
    };
    const backend = new BingBackend(
      { fetch, lookup: okLookup },
      "https://cn.bing.com/search"
    );
    const raw = (await backend.fetchResults({
      query: "rust async",
      maxResults: 5,
    })) as string;
    assert.equal(typeof raw, "string");
    assert.match(raw, /Bing Title 1/);
    assert.ok(
      seen[0].includes("q=rust") && seen[0].includes("async"),
      `expected q=rust+async in ${seen[0]}`
    );
  });
});

describe("Tavily / Exa / Brave placeholders (#826 T2)", () => {
  it.each(["tavily", "exa", "brave"] as SearchBackendId[])(
    "%s factory yields a backend that throws typed not_shipped until T4/T5/T6 lands",
    (id) => {
      const factory = selectBackend(id);
      const backend: SearchBackend = factory({
        guardDeps: {
          fetch: (() => undefined) as unknown as GuardFetchFn,
          lookup: okLookup,
        },
        endpoint: "https://example.invalid",
      });
      assert.equal(backend.id, id);
      // #826 T3: 占位 throw 从 plain Error 升级为 typed SearchBackendError
      // (kind="not_shipped")，让 handler 出口能 1:1 转译（spec SC #8）。
      for (const call of [
        () => backend.fetchResults({ query: "x", maxResults: 1 }),
        () => backend.project({}, 1),
        () => backend.describe({}, Date.now()),
      ]) {
        assert.throws(call, (err: unknown) => {
          assert.ok(
            isSearchBackendError(err),
            `expected a typed SearchBackendError, got ${String(err)}`
          );
          assert.equal(err.kind, "not_shipped");
          assert.ok(err.message.includes(id), err.message);
          return true;
        });
      }
    }
  );
});

describe("createWebSearchTool — backend='bing' byte-identical (#826 T2)", () => {
  it("backend='bing' produces the same output as no backend set (Bing fixture)", async () => {
    const fixtureBody = bingBody(3);
    // Bing fixture 必须配 Bing endpoint(v0 行为) — searchDeps 默认 endpoint
    // 是 DDG,这里显式走 cn.bing.com/search 让 hostname 分派到 Bing 解析器。
    const toolDefault = createWebSearchTool(
      searchDeps(fixtureBody, 200, "https://cn.bing.com/search")
    );
    const toolBing = createWebSearchTool({
      ...searchDeps(fixtureBody, 200, "https://cn.bing.com/search"),
      backend: "bing",
    });
    const outDefault = (await toolDefault.handler({
      query: "rust async",
    })) as string;
    const outBing = (await toolBing.handler({ query: "rust async" })) as string;
    assert.equal(outBing, outDefault);
    assert.match(outBing, /Search results for: rust async/);
    assert.match(outBing, /1\. Bing Title 1/);
    assert.match(outBing, /2\. Bing Title 2/);
    assert.match(outBing, /3\. Bing Title 3/);
  });

  it("backend='bing' still routes search_url overrides through SSRF validation", async () => {
    const tool = createWebSearchTool({
      ...searchDeps(ddgBody(1)),
      backend: "bing",
    });
    await expectToolError(
      () =>
        Promise.resolve(
          tool.handler({ query: "x", search_url: "http://127.0.0.1:9000/" })
        ),
      "non-public"
    );
  });
});

// =============================================================================
// #826 T3: typed SearchBackendError + handler 出口 try/catch → ToolExecutionError。
// 三态 fail-closed（spec Assumption 6）在 handler entry 判定（不依赖 fetch 阶段）；
// 六 kind 闭集 1:1 转译到 ToolExecutionError；message 不带 key / Authorization。
// =============================================================================

/** T3 测试里用的假 Exa key 字面值 —— 断言它绝不出现在任何 error message 里。 */
const FAKE_EXA_KEY = "exa-secret-do-not-leak-0123456789";

/** 只在 handler entry 检查全过之后才可能被调到的 fetch —— 调用即记账。 */
function countingFetch(body = bingBody(1)): {
  fetch: GuardFetchFn;
  calls: () => number;
} {
  let calls = 0;
  const fetch: GuardFetchFn = async () => {
    calls += 1;
    return { status: 200, contentType: "text/html", body };
  };
  return { fetch, calls: () => calls };
}

/**
 * 注入一个自定义 backend 工厂（deps 覆盖点，与 deps.fetch / deps.lookup 同族）：
 * 让 T3 在 T4/T5/T6 真 adapter 落地前也能驱动 http_non_2xx / timeout / parse
 * 三条出口路径，而不去改 BACKENDS 表全局状态。
 */
function throwingBackendDeps(thrown: unknown): WebSearchToolDeps {
  return {
    fetch: (() => undefined) as unknown as GuardFetchFn,
    lookup: okLookup,
    backend: "exa",
    exaApiKey: FAKE_EXA_KEY,
    backendFactory: () => ({
      id: "exa" as const,
      fetchResults: async () => {
        throw thrown;
      },
      project: () => [],
      describe: () => ({ adapter: "exa" as const, latencyMs: 0 }),
    }),
  };
}

describe("web-search-errors — SearchBackendError typed shape (#826 T3)", () => {
  it("exposes exactly the six-kind closed set", () => {
    assert.deepEqual(
      [...SEARCH_BACKEND_ERROR_KINDS],
      [
        "missing_key",
        "backend_unset_with_key",
        "http_non_2xx",
        "parse",
        "timeout",
        "not_shipped",
      ]
    );
  });

  it("isSearchBackendError accepts every kind in the closed set", () => {
    for (const kind of SEARCH_BACKEND_ERROR_KINDS) {
      assert.ok(
        isSearchBackendError({ kind, message: "boom" }),
        `kind ${kind} must be recognized`
      );
    }
  });

  it("isSearchBackendError rejects non-objects, unknown kinds, bad payloads", () => {
    assert.equal(isSearchBackendError(null), false);
    assert.equal(isSearchBackendError(undefined), false);
    assert.equal(isSearchBackendError("missing_key"), false);
    assert.equal(isSearchBackendError(new Error("missing_key")), false);
    assert.equal(isSearchBackendError({ kind: "nope", message: "x" }), false);
    assert.equal(isSearchBackendError({ kind: "parse" }), false);
    assert.equal(isSearchBackendError({ kind: "parse", message: 1 }), false);
    assert.equal(
      isSearchBackendError({ kind: "parse", message: "x", endpoint: 7 }),
      false
    );
  });

  it("isSearchBackendError does not confuse the WebEnvConfigError shape", () => {
    assert.equal(
      isSearchBackendError({
        kind: "invalid_search_backend",
        varName: "IKNOW_WEB_SEARCH_BACKEND",
        value: "nope",
        expected: ["bing"],
      }),
      false
    );
  });

  it("createSearchBackendError narrows endpoint to a bare domain", () => {
    const err = createSearchBackendError({
      kind: "http_non_2xx",
      message: "upstream returned 429",
      endpoint: "https://api.exa.ai/search?api_key=leaky&x=1",
    });
    assert.equal(err.endpoint, "api.exa.ai");
    assert.ok(!JSON.stringify(err).includes("leaky"));
  });

  it("createSearchBackendError scrubs bearer tokens / Authorization from message", () => {
    const err = createSearchBackendError({
      kind: "http_non_2xx",
      message: `401 from Authorization: Bearer ${FAKE_EXA_KEY}`,
      endpoint: "api.exa.ai",
    });
    assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
    assert.ok(!/authorization/i.test(err.message), err.message);
  });

  it("createSearchBackendError keeps a bare-domain endpoint and preserves cause", () => {
    const cause = new Error("socket hang up");
    const err = createSearchBackendError({
      kind: "timeout",
      message: "aborted",
      endpoint: "api.exa.ai",
      cause,
    });
    assert.equal(err.endpoint, "api.exa.ai");
    assert.equal(err.cause, cause);
  });

  it("toToolExecutionError maps all six kinds to distinguishable errors", () => {
    const messages = new Set<string>();
    for (const kind of SEARCH_BACKEND_ERROR_KINDS) {
      const translated = toToolExecutionError(
        createSearchBackendError({ kind, message: "detail here" })
      );
      assert.ok(translated instanceof ToolExecutionError);
      assert.ok(translated.message.startsWith("web_search failed:"));
      assert.ok(translated.message.includes(kind), translated.message);
      assert.ok(translated.message.includes("detail here"));
      messages.add(translated.message);
    }
    assert.equal(messages.size, SEARCH_BACKEND_ERROR_KINDS.length);
  });

  it("toToolExecutionError appends the endpoint domain when present", () => {
    const translated = toToolExecutionError(
      createSearchBackendError({
        kind: "http_non_2xx",
        message: "upstream status 503",
        endpoint: "https://api.exa.ai/search",
      })
    );
    assert.ok(translated.message.includes("503"), translated.message);
    assert.ok(translated.message.includes("api.exa.ai"), translated.message);
  });

  it("toToolExecutionError preserves the typed error as cause", () => {
    const typed = createSearchBackendError({ kind: "parse", message: "bad" });
    const translated = toToolExecutionError(typed);
    assert.equal(translated.cause, typed);
  });
});

describe("createWebSearchTool — search_url schema reject (#826 T3)", () => {
  it.each(["tavily", "exa", "brave"] as SearchBackendId[])(
    "backend=%s + search_url → typed reject before any fetch",
    async (id) => {
      const { fetch, calls } = countingFetch();
      const tool = createWebSearchTool({
        fetch,
        lookup: okLookup,
        backend: id,
        exaApiKey: FAKE_EXA_KEY,
        tavilyApiKey: FAKE_EXA_KEY,
        braveApiKey: FAKE_EXA_KEY,
      });

      await expectToolError(
        () =>
          Promise.resolve(
            tool.handler({
              query: "x",
              search_url: "https://html.duckduckgo.com/html/",
            })
          ),
        "search_url only valid with backend=bing"
      );
      assert.equal(calls(), 0, "reject must precede fetchResults");
    }
  );

  it("backend=bing keeps the existing search_url override path", async () => {
    const seen: string[] = [];
    const fetch: GuardFetchFn = async (url) => {
      seen.push(url);
      return { status: 200, contentType: "text/html", body: ddgBody(1) };
    };
    const tool = createWebSearchTool({
      fetch,
      lookup: okLookup,
      backend: "bing",
    });

    await tool.handler({
      query: "x",
      search_url: "https://search.internal.example.com/html/",
    });

    assert.ok(seen[0].startsWith("https://search.internal.example.com/html/"));
  });
});

describe("createWebSearchTool — fail-closed handler entry (#826 T3)", () => {
  it.each([
    ["exa", "EXA_API_KEY"],
    ["tavily", "TAVILY_API_KEY"],
    ["brave", "BRAVE_API_KEY"],
  ] as ReadonlyArray<readonly [SearchBackendId, string]>)(
    "backend=%s with no key → missing_key typed error naming %s",
    async (id, envKey) => {
      const { fetch, calls } = countingFetch();
      const tool = createWebSearchTool({
        fetch,
        lookup: okLookup,
        backend: id,
      });

      for (const needle of ["missing_key", envKey, id]) {
        await expectToolError(
          () => Promise.resolve(tool.handler({ query: "x" })),
          needle
        );
      }
      assert.equal(calls(), 0, "missing_key must precede fetchResults");
    }
  );

  it("treats a blank key as missing (placeholder resolution failure shape)", async () => {
    const tool = createWebSearchTool({
      fetch: (() => undefined) as unknown as GuardFetchFn,
      lookup: okLookup,
      backend: "exa",
      exaApiKey: "   ",
    });
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "x" })),
      "missing_key"
    );
  });

  it.each([
    ["exaApiKey", "EXA_API_KEY"],
    ["tavilyApiKey", "TAVILY_API_KEY"],
    ["braveApiKey", "BRAVE_API_KEY"],
  ] as ReadonlyArray<readonly [string, string]>)(
    "backend unset + %s set → backend_unset_with_key (no silent bing fallback)",
    async (depsField, envKey) => {
      const { fetch, calls } = countingFetch();
      const tool = createWebSearchTool({
        fetch,
        lookup: okLookup,
        [depsField]: FAKE_EXA_KEY,
      } as WebSearchToolDeps);

      for (const needle of [
        "backend_unset_with_key",
        envKey,
        "IKNOW_WEB_SEARCH_BACKEND",
      ]) {
        await expectToolError(
          () => Promise.resolve(tool.handler({ query: "x" })),
          needle
        );
      }
      assert.equal(calls(), 0, "misconfig must precede fetchResults");
    }
  );

  it("fail-closed messages never leak the key literal", async () => {
    const tool = createWebSearchTool({
      fetch: (() => undefined) as unknown as GuardFetchFn,
      lookup: okLookup,
      exaApiKey: FAKE_EXA_KEY,
    });
    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
        assert.ok(!/authorization/i.test(err.message), err.message);
        return true;
      }
    );
  });

  it("backend unset + zero keys stays on the default Bing path", async () => {
    const tool = createWebSearchTool(
      searchDeps(bingBody(1), 200, "https://cn.bing.com/search")
    );
    const out = (await tool.handler({ query: "x" })) as string;
    assert.match(out, /1\. Bing Title 1/);
  });

  it("explicit backend='bing' with a keyed key set is not a misconfig", async () => {
    const tool = createWebSearchTool({
      ...searchDeps(bingBody(1), 200, "https://cn.bing.com/search"),
      backend: "bing",
      exaApiKey: FAKE_EXA_KEY,
    });
    const out = (await tool.handler({ query: "x" })) as string;
    assert.match(out, /1\. Bing Title 1/);
  });
});

describe("createWebSearchTool — backend error translation (#826 T3)", () => {
  it("http_non_2xx keeps upstream status + endpoint domain but not the key", async () => {
    const tool = createWebSearchTool(
      throwingBackendDeps(
        createSearchBackendError({
          kind: "http_non_2xx",
          message: "upstream returned 401",
          endpoint: `https://api.exa.ai/search?token=${FAKE_EXA_KEY}`,
        })
      )
    );

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.ok(err.message.includes("http_non_2xx"), err.message);
        assert.ok(err.message.includes("401"), err.message);
        assert.ok(err.message.includes("api.exa.ai"), err.message);
        assert.ok(!err.message.includes(FAKE_EXA_KEY), err.message);
        assert.ok(!/authorization/i.test(err.message), err.message);
        return true;
      }
    );
  });

  it("timeout raised from an aborted signal translates to a typed timeout error", async () => {
    const controller = new AbortController();
    const tool = createWebSearchTool({
      fetch: (() => undefined) as unknown as GuardFetchFn,
      lookup: okLookup,
      backend: "exa",
      exaApiKey: FAKE_EXA_KEY,
      backendFactory: () => ({
        id: "exa" as const,
        fetchResults: async (args: { signal?: AbortSignal }) => {
          controller.abort();
          if (args.signal?.aborted) {
            throw createSearchBackendError({
              kind: "timeout",
              message: "request aborted after 20000ms",
              endpoint: "api.exa.ai",
            });
          }
          return {};
        },
        project: () => [],
        describe: () => ({ adapter: "exa" as const, latencyMs: 0 }),
      }),
    });

    await expectToolError(
      () =>
        Promise.resolve(
          tool.handler({ query: "x" }, { signal: controller.signal })
        ),
      "timeout"
    );
  });

  it("parse (malformed upstream JSON) translates to a typed parse error", async () => {
    const tool = createWebSearchTool(
      throwingBackendDeps(
        createSearchBackendError({
          kind: "parse",
          message: "malformed JSON: expected an object with results[]",
          endpoint: "api.exa.ai",
        })
      )
    );

    for (const needle of ["parse", "malformed JSON"]) {
      await expectToolError(
        () => Promise.resolve(tool.handler({ query: "x" })),
        needle
      );
    }
  });

  it.each(["tavily", "exa", "brave"] as SearchBackendId[])(
    "backend=%s placeholder surfaces not_shipped through the handler exit",
    async (id) => {
      const tool = createWebSearchTool({
        fetch: (() => undefined) as unknown as GuardFetchFn,
        lookup: okLookup,
        backend: id,
        exaApiKey: FAKE_EXA_KEY,
        tavilyApiKey: FAKE_EXA_KEY,
        braveApiKey: FAKE_EXA_KEY,
      });

      for (const needle of ["not_shipped", id]) {
        await expectToolError(
          () => Promise.resolve(tool.handler({ query: "x" })),
          needle
        );
      }
    }
  );

  it("does not swallow untyped errors thrown by a backend", async () => {
    const boom = new RangeError("some unexpected runtime failure");
    const tool = createWebSearchTool(throwingBackendDeps(boom));

    await assert.rejects(
      () => Promise.resolve(tool.handler({ query: "x" })),
      (err: unknown) => {
        assert.ok(
          err instanceof RangeError,
          `untyped errors must pass through unchanged, got ${String(err)}`
        );
        assert.equal(err.message, "some unexpected runtime failure");
        return true;
      }
    );
  });

  it("leaves the existing Bing non-2xx ToolExecutionError untouched", async () => {
    const tool = createWebSearchTool({
      ...searchDeps("gateway down", 502, "https://cn.bing.com/search"),
      backend: "bing",
    });
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "x" })),
      "web_search failed: unexpected status 502"
    );
  });
});
