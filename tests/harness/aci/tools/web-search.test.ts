/**
 * web_search 工具单元测试。
 *
 * 行为真值：upstream-openharness tools/web_search_tool.py
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
  createWebSearchTool,
  type WebSearchToolDeps,
} from "../../../../src/harness/aci/tools/web-search.ts";
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

function searchDeps(body: string, status = 200): WebSearchToolDeps {
  const fetch: GuardFetchFn = async () => ({
    status,
    contentType: "text/html; charset=UTF-8",
    body,
  });
  return { fetch, lookup: okLookup };
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
    const tool = createWebSearchTool({ fetch, lookup: okLookup });
    await tool.handler({ query: "hello world" });
    assert.ok(
      seen.some((u) => u.includes("q=hello") && u.includes("world")),
      `expected q=hello+world in ${seen.join(",")}`
    );
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

describe("createWebSearchTool — failure paths", () => {
  it("rejects empty query", async () => {
    const tool = createWebSearchTool(searchDeps(ddgBody(1)));
    await expectToolError(() => Promise.resolve(tool.handler({})), "query");
    await expectToolError(
      () => Promise.resolve(tool.handler({ query: "" })),
      "query"
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
    const toolB = createWebSearchTool({ fetch: fetchB, lookup: okLookup });
    const [outA, outB] = await Promise.all([
      toolA.handler({ query: "a" }),
      toolB.handler({ query: "b" }),
    ]);
    assert.match(outA as string, /Search results for: a/);
    assert.match(outB as string, /Search results for: b/);
    assert.match(outB as string, /2\. Title 2/);
    assert.ok(!(outA as string).includes("2. Title 2"));
  });
});
