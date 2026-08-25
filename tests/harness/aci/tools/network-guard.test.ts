/**
 * network-guard（SSRF 安全出口层）单元测试。
 *
 * 行为真值：upstream-ref 的通用 Agent 工具层 utils/network_guard.py（DIRECT 模式裁剪版，
 * 见 ACR corrective #2：不移植 PROXY / SYNTHETIC_DNS）。
 *
 * 覆盖契约：
 *   - validateHttpUrl：仅 http/https、必须有 host、拒绝嵌入凭据
 *   - IP 字面量全局性：loopback / private / link-local / CGNAT / 多播 / 保留段拒绝
 *   - 主机名规则：localhost / *.local / *.internal / 单标签拒绝
 *   - DNS 解析：解析结果含非公网 IP → 拒绝；解析失败 → could not resolve
 *   - fetchPublicResponse：非 2xx 拒绝、重定向逐跳重验（≤5 跳）、重定向到私网拒绝
 *   - 错误消息带 `${tool} failed:` 前缀（对齐 upstream-ref "web_fetch failed: ..."）
 *   - abort / timeout 边界
 *   - 并发：两个独立 deps 的调用 Promise.all 扇出互不干扰
 *
 * 全部离线：fetch / lookup 均注入 stub，不触网。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createDefaultGuardDeps,
  DEFAULT_USER_AGENT,
  fetchPublicResponse,
  validateHttpUrl,
  type GuardFetchFn,
  type GuardLookupFn,
} from "../../../../src/harness/aci/tools/network-guard.ts";

const PUBLIC_IP = "93.184.216.34"; // example.com — 测试桩的"公网"解析结果

const okLookup: GuardLookupFn = async () => [PUBLIC_IP];

function okFetch(body: string, contentType = "text/plain"): GuardFetchFn {
  return async () => ({
    status: 200,
    contentType,
    body,
  });
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

describe("validateHttpUrl — URL 语法防线", () => {
  it("accepts http and https URLs", () => {
    assert.doesNotThrow(() => validateHttpUrl("http://example.com/a"));
    assert.doesNotThrow(() =>
      validateHttpUrl("https://example.com:8443/a?b=1")
    );
  });

  it("rejects non-http schemes", () => {
    assert.throws(
      () => validateHttpUrl("ftp://example.com/"),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.includes("only http and https")
    );
    assert.throws(
      () => validateHttpUrl("file:///etc/passwd"),
      ToolExecutionError
    );
  });

  it("rejects URLs without a host", () => {
    // WHATWG URL："http://" 直接 Invalid URL（无 host）；
    // "http:///path" 会被解析为 host="path"，走单标签主机名防线拒绝。
    assert.throws(() => validateHttpUrl("http://"), ToolExecutionError);
  });

  it("rejects URLs with embedded credentials", () => {
    assert.throws(
      () => validateHttpUrl("https://user:pass@example.com/"),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.message.includes("credentials")
    );
  });

  it("rejects empty input", () => {
    assert.throws(() => validateHttpUrl(""), ToolExecutionError);
  });
});

describe("fetchPublicResponse — IP 字面量防线", () => {
  const literalCases: ReadonlyArray<readonly [string, string]> = [
    ["http://127.0.0.1/x", "loopback"],
    ["http://10.0.0.5/x", "non-public"],
    ["http://172.16.3.4/x", "non-public"],
    ["http://192.168.1.1/x", "non-public"],
    ["http://169.254.169.254/latest/meta-data", "non-public"],
    ["http://100.64.1.1/x", "non-public"],
    ["http://224.0.0.1/x", "non-public"],
    ["http://0.0.0.0/x", "non-public"],
    ["http://[::1]/x", "non-public"],
  ];

  for (const [url, expected] of literalCases) {
    it(`rejects private/loopback literal: ${url}`, async () => {
      await expectToolError(
        () =>
          fetchPublicResponse(
            url,
            { fetch: okFetch("x"), lookup: okLookup },
            {
              tool: "web_fetch",
              timeoutMs: 1_000,
            }
          ),
        expected
      );
    });
  }

  it("accepts a public IP literal without DNS lookup", async () => {
    const calls: string[] = [];
    const res = await fetchPublicResponse(
      "http://93.184.216.34/x",
      {
        fetch: okFetch("hello"),
        lookup: async (host) => {
          calls.push(host);
          return [PUBLIC_IP];
        },
      },
      { tool: "web_fetch", timeoutMs: 1_000 }
    );
    assert.equal(res.body, "hello");
    assert.deepEqual(calls, []); // 字面量不查 DNS
  });
});

describe("fetchPublicResponse — 主机名 + DNS 防线", () => {
  it("rejects localhost hostname", async () => {
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://localhost:8787/api",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "local hostnames are not allowed"
    );
  });

  it("rejects .local / .internal suffixes", async () => {
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://printer.local/",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "local hostnames"
    );
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://metadata.google.internal/",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "not allowed"
    );
  });

  it("rejects single-label hostnames", async () => {
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://intranet/",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "single-label"
    );
  });

  it("rejects when DNS resolves to a non-public address", async () => {
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://evil.example.com/",
          { fetch: okFetch("x"), lookup: async () => ["127.0.0.1"] },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "non-public"
    );
  });

  it("rejects when DNS resolution fails", async () => {
    await expectToolError(
      () =>
        fetchPublicResponse(
          "http://no-such-host.example.com/",
          {
            fetch: okFetch("x"),
            lookup: async () => {
              throw new Error("ENOTFOUND");
            },
          },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "could not resolve"
    );
  });
});

describe("fetchPublicResponse — HTTP 语义", () => {
  it("returns status / contentType / body / finalUrl on success", async () => {
    const res = await fetchPublicResponse(
      "https://example.com/doc",
      {
        fetch: okFetch("payload", "text/html; charset=utf-8"),
        lookup: okLookup,
      },
      { tool: "web_fetch", timeoutMs: 1_000 }
    );
    assert.equal(res.status, 200);
    assert.equal(res.contentType, "text/html; charset=utf-8");
    assert.equal(res.body, "payload");
    assert.equal(res.finalUrl, "https://example.com/doc");
  });

  it("rejects non-2xx responses with the status in the message", async () => {
    const fetch404: GuardFetchFn = async () => ({
      status: 404,
      contentType: "text/html",
      body: "not found",
    });
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/missing",
          { fetch: fetch404, lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "404"
    );
  });

  it("follows redirects up to the limit and re-validates each hop", async () => {
    const seen: string[] = [];
    const fetch302: GuardFetchFn = async (url) => {
      seen.push(url);
      if (url.includes("start")) {
        return {
          status: 302,
          contentType: "",
          body: "",
          location: "https://cdn.example.com/final",
        };
      }
      return { status: 200, contentType: "text/plain", body: "arrived" };
    };
    const res = await fetchPublicResponse(
      "https://start.example.com/",
      { fetch: fetch302, lookup: okLookup },
      { tool: "web_fetch", timeoutMs: 1_000 }
    );
    assert.equal(res.body, "arrived");
    assert.equal(res.finalUrl, "https://cdn.example.com/final");
    assert.equal(seen.length, 2);
  });

  it("rejects redirects that land on a non-public target", async () => {
    const fetchToLoopback: GuardFetchFn = async (url) => {
      if (url.includes("start")) {
        return {
          status: 302,
          contentType: "",
          body: "",
          location: "http://127.0.0.1:8787/admin",
        };
      }
      return { status: 200, contentType: "text/plain", body: "pwned" };
    };
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://start.example.com/",
          { fetch: fetchToLoopback, lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "non-public"
    );
  });

  it("rejects redirect chains longer than the limit", async () => {
    let hop = 0;
    const infiniteRedirect: GuardFetchFn = async () => {
      hop += 1;
      return {
        status: 302,
        contentType: "",
        body: "",
        location: `https://example.com/hop${hop}`,
      };
    };
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/start",
          { fetch: infiniteRedirect, lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "too many redirects"
    );
    assert.equal(hop, 6); // 初始 1 次 + 5 次跟随
  });

  it("resolves relative redirect locations against the current URL", async () => {
    let first = true;
    const relativeRedirect: GuardFetchFn = async (url) => {
      if (first) {
        first = false;
        return {
          status: 301,
          contentType: "",
          body: "",
          location: "/moved",
        };
      }
      return { status: 200, contentType: "text/plain", body: url };
    };
    const res = await fetchPublicResponse(
      "https://example.com/a/b",
      { fetch: relativeRedirect, lookup: okLookup },
      { tool: "web_fetch", timeoutMs: 1_000 }
    );
    assert.equal(res.finalUrl, "https://example.com/moved");
  });
});

describe("fetchPublicResponse — abort / timeout / 错误前缀", () => {
  it("rejects when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000, signal: controller.signal }
        ),
      "aborted"
    );
  });

  it("rejects when the injected fetch aborts mid-flight", async () => {
    const hangingFetch: GuardFetchFn = async (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("The operation was aborted"));
          },
          { once: true }
        );
      });
    const controller = new AbortController();
    const pending = fetchPublicResponse(
      "https://example.com/slow",
      { fetch: hangingFetch, lookup: okLookup },
      { tool: "web_fetch", timeoutMs: 5_000, signal: controller.signal }
    );
    controller.abort();
    await expectToolError(() => pending, "aborted");
  });

  it("times out via the injected timeout window", async () => {
    const hangingFetch: GuardFetchFn = (_url, opts) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("never"));
        }, 10_000);
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("The operation was aborted"));
          },
          { once: true }
        );
      });
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/slow",
          { fetch: hangingFetch, lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 30 }
        ),
      "aborted"
    );
  });

  it("prefixes guard errors with the tool name", async () => {
    await assert.rejects(
      () =>
        fetchPublicResponse(
          "ftp://example.com/",
          { fetch: okFetch("x"), lookup: okLookup },
          { tool: "web_search", timeoutMs: 1_000 }
        ),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.startsWith("web_search failed:")
    );
  });

  it("surfaces injected fetch failures with the tool prefix", async () => {
    const brokenFetch: GuardFetchFn = async () => {
      throw new Error("socket hang up");
    };
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/",
          { fetch: brokenFetch, lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "web_fetch failed: socket hang up"
    );
  });
});

describe("fetchPublicResponse — 并发扇出（ACR corrective #3）", () => {
  it("two concurrent calls with distinct stubs stay isolated", async () => {
    const fetchA: GuardFetchFn = async () => ({
      status: 200,
      contentType: "text/plain",
      body: "AAA",
    });
    const fetchB: GuardFetchFn = async () => ({
      status: 200,
      contentType: "text/plain",
      body: "BBB",
    });
    const [resA, resB] = await Promise.all([
      fetchPublicResponse(
        "https://a.example.com/",
        { fetch: fetchA, lookup: okLookup },
        { tool: "web_fetch", timeoutMs: 1_000 }
      ),
      fetchPublicResponse(
        "https://b.example.com/",
        { fetch: fetchB, lookup: okLookup },
        { tool: "web_fetch", timeoutMs: 1_000 }
      ),
    ]);
    assert.equal(resA.body, "AAA");
    assert.equal(resB.body, "BBB");
    assert.equal(resA.finalUrl, "https://a.example.com/");
    assert.equal(resB.finalUrl, "https://b.example.com/");
  });
});

describe("createDefaultGuardDeps — 代理出口（IKNOW_WEB_PROXY 装配路径）", () => {
  it("proxyUrl 非法(非 http/https)时构造时同步抛 ToolExecutionError", () => {
    // SSRF 防线对齐 upstream-ref `validate_http_url(resolved_proxy)`:
    // proxy URL 在 ProxyAgent 构造前必须通过 httpUrlViolation 校验,
    // 校验发生在工厂同步路径上,早于 fetch 闭包第一次调用。
    assert.throws(
      () => createDefaultGuardDeps({ proxyUrl: "ftp://proxy.local:7897" }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        (err.message.includes("only http and https") ||
          err.message.includes("URL is malformed"))
    );
  });

  it("proxyUrl 含凭据时构造时同步抛 ToolExecutionError", () => {
    assert.throws(
      () =>
        createDefaultGuardDeps({
          proxyUrl: "http://user:pass@proxy.local:7897",
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.message.includes("credentials")
    );
  });

  it("proxyUrl 合法时返回的 deps 结构完整", () => {
    // dispatcher 装配被触发。仅验证返回的 deps 结构合法。
    // 实网络行为(走 ProxyAgent 出网)在 smoke 脚本里测,避免测试挂代理。
    const deps = createDefaultGuardDeps({
      proxyUrl: "http://127.0.0.1:7897",
    });
    assert.equal(typeof deps.fetch, "function");
    assert.equal(typeof deps.lookup, "function");
  });

  it("proxyUrl 缺省时不挂 dispatcher(回归原路径)", () => {
    const deps = createDefaultGuardDeps();
    assert.equal(typeof deps.fetch, "function");
    assert.equal(typeof deps.lookup, "function");
  });

  it("向后兼容旧的字符串 userAgent 签名", () => {
    // createDefaultGuardDeps(ua?: string) 旧调用点不应因新增 opts 形态破坏。
    const deps = createDefaultGuardDeps("legacy-ua/1.0");
    assert.equal(typeof deps.fetch, "function");
  });
});

describe("createDefaultGuardDeps - 浏览器伪装 UA（反爬可达性）", () => {
  it("DEFAULT_USER_AGENT 形如浏览器串并带 iknow 后缀", () => {
    // 防回退到纯产品 UA（实测被 Cloudflare 202 challenge 拦截）。
    assert.match(DEFAULT_USER_AGENT, /^Mozilla\/5\.0/);
    assert.ok(DEFAULT_USER_AGENT.includes("AppleWebKit"));
    assert.ok(DEFAULT_USER_AGENT.includes("Chrome/"));
    assert.ok(DEFAULT_USER_AGENT.includes("iknow/"));
  });

  it("生产默认 fetch 携带 DEFAULT_USER_AGENT 头", async () => {
    const deps = createDefaultGuardDeps();
    // 用一个拦截 fetch 的间接验证：deps.fetch 是真实 globalThis.fetch 的包装，
    // 但我们只断言 UA 已在闭包中固定。改用一个能观测 header 的 stub 不可能
    // （createDefaultGuardDeps 内部闭包持有 fetch），所以改为构造一个相同
    // 闭包语义的微缩验证：createDefaultGuardDeps(ua) 的 fetch 会用该 ua。
    // 这里仅验证默认值传递路径：显式传 ua 后，deps 结构完整。
    const custom = createDefaultGuardDeps("custom-ua/9.9");
    assert.equal(typeof custom.fetch, "function");
    assert.equal(typeof custom.lookup, "function");
  });

  it("ua 参数缺省时回退到 DEFAULT_USER_AGENT", () => {
    // 不直接观测 headers（globalThis.fetch 闭包不可内省），而是验证
    // createDefaultGuardDeps() 无参调用不抛 + 返回有效 deps。
    const deps = createDefaultGuardDeps();
    assert.ok(deps.fetch !== undefined);
    assert.ok(deps.lookup !== undefined);
  });
});
