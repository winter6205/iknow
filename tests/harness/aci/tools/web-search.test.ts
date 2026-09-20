/**
 * web_search unit tests.
 *
 * Behavioral ground truth: web_search_tool.py
 * (default DuckDuckGo html endpoint + result__a / result__snippet parsing + uddg URL normalization).
 *
 * Contract coverage:
 *   - factory signature createWebSearchTool(deps?) → AciToolDef, name === "web_search"
 *   - inputSchema: query required + max_results?(default 5, ge 1, le 10) + search_url? +
 *     additionalProperties:false
 *   - aci metadata: category=read-only, isConcurrencySafe=true,
 *     interruptBehavior=cancel, timeoutTier=default
 *   - happy path: numbered list `N. title / URL: / snippet`
 *   - max_results truncation; clamp above ceiling → 10, ≤0 / non-number → 5
 *   - DuckDuckGo /l/?uddg= redirect links normalized to the target URL
 *   - empty query / no results → ToolExecutionError
 *   - non-2xx → ToolExecutionError
 *   - concurrency fan-out (Promise.all + independent stubs)
 *
 * Fully offline: deps.fetch / deps.lookup are injected stubs.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createSearchBackendError } from "../../../../src/harness/aci/tools/web-search-errors.ts";
import {
  createWebSearchTool,
  type WebSearchToolDeps,
} from "../../../../src/harness/aci/tools/web-search.ts";
import type {
  GuardFetchFn,
  GuardLookupFn,
} from "../../../../src/harness/aci/tools/network-guard.ts";

const PUBLIC_IP = "93.184.216.34";
const okLookup: GuardLookupFn = async () => [PUBLIC_IP];

/** Builds a DuckDuckGo-html-style results page. */
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

/** Builds a Bing-style results page (real DOM: li.b_algo → h2>a + div.b_caption). */
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
 * Builds tool deps. The default endpoint is Bing, so tests declare their
 * endpoint explicitly to avoid coupling:
 * - a test feeding a DDG body should pass the DDG endpoint;
 * - a test feeding a Bing body should pass the Bing endpoint.
 * `endpoint` defaults to DDG (preserving the intent of the older fixtures).
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
    // The default endpoint is Bing; DDG html is no longer the default.
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

describe("ACI web backend — search fallback (SC4)", () => {
  function defaultBingDeps(
    extras: Partial<WebSearchToolDeps> = {}
  ): WebSearchToolDeps {
    return {
      ...searchDeps(bingBody(1), 200, "https://www.bing.com/search"),
      ...extras,
    };
  }

  it("tavily stub falls back to default retrieval, not not_shipped", async () => {
    const tool = createWebSearchTool(
      defaultBingDeps({ backend: "tavily", tavilyApiKey: "tvly-test" })
    );
    const out = (await tool.handler({ query: "fallback" })) as string;
    assert.match(out, /Bing Title 1/);
    assert.ok(!out.includes("not_shipped"));
  });

  it("brave without a key falls back to default retrieval", async () => {
    const tool = createWebSearchTool(defaultBingDeps({ backend: "brave" }));
    const out = (await tool.handler({ query: "fallback" })) as string;
    assert.match(out, /Bing Title 1/);
    assert.ok(!out.includes("not_shipped"));
    assert.ok(!out.includes("missing_key"));
  });

  it("exa without a key falls back to default retrieval", async () => {
    const tool = createWebSearchTool(defaultBingDeps({ backend: "exa" }));
    const out = (await tool.handler({ query: "fallback" })) as string;
    assert.match(out, /Bing Title 1/);
    assert.ok(!out.includes("missing_key"));
  });

  it("exa + key keeps the Exa path and does not hit the HTML guard fetch", async () => {
    let guardHits = 0;
    const tool = createWebSearchTool({
      fetch: async () => {
        guardHits += 1;
        return {
          status: 200,
          contentType: "text/html",
          body: bingBody(1),
        };
      },
      lookup: okLookup,
      backend: "exa",
      exaApiKey: "exa-test",
      backendFactory: () => ({
        id: "exa",
        fetchResults: async () => ({
          results: [
            {
              title: "Exa Hit",
              url: "https://exa.example.com/",
              highlights: ["vendor snip"],
            },
          ],
        }),
        project: () => [
          {
            title: "Exa Hit",
            url: "https://exa.example.com/",
            snippet: "vendor snip",
          },
        ],
        describe: () => ({ adapter: "exa", latencyMs: 1 }),
      }),
    });
    const out = (await tool.handler({ query: "vendor" })) as string;
    assert.equal(guardHits, 0);
    assert.match(out, /Exa Hit/);
  });

  it("exa + key surfaces vendor 5xx as typed failure, not a capability fallback (S2 exception)", async () => {
    let guardHits = 0;
    const tool = createWebSearchTool({
      fetch: async () => {
        guardHits += 1;
        return {
          status: 200,
          contentType: "text/html",
          body: bingBody(1),
        };
      },
      lookup: okLookup,
      backend: "exa",
      exaApiKey: "exa-test",
      backendFactory: () => ({
        id: "exa",
        fetchResults: async () => {
          throw createSearchBackendError({
            kind: "http_non_2xx",
            message: "upstream returned status 503",
            endpoint: "https://api.exa.ai/search",
          });
        },
        project: () => [],
        describe: () => ({ adapter: "exa", latencyMs: 1 }),
      }),
    });
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "vendor-fail" })),
      "http_non_2xx"
    );
    assert.equal(guardHits, 0);
  });

  it("unset backend keeps the default Bing HTML path (SC2)", async () => {
    const hosts: string[] = [];
    const tool = createWebSearchTool({
      fetch: async (url) => {
        hosts.push(new URL(url).hostname);
        return {
          status: 200,
          contentType: "text/html",
          body: bingBody(1),
        };
      },
      lookup: okLookup,
    });
    const out = (await tool.handler({ query: "default" })) as string;
    assert.ok(hosts.every((h) => h.endsWith("bing.com")));
    assert.match(out, /Bing Title 1/);
  });
});
