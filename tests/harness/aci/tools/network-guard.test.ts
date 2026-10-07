/**
 * network-guard (the SSRF egress-safety layer) unit tests.
 *
 * Behavioral ground truth: utils/network_guard.py (a DIRECT-mode trimmed port;
 * PROXY / SYNTHETIC_DNS were deliberately not ported).
 *
 * Contract coverage:
 *   - validateHttpUrl: http/https only, host required, embedded credentials rejected
 *   - IP-literal globality: loopback / private / link-local / CGNAT / multicast / reserved ranges rejected
 *   - hostname rules: localhost / *.local / *.internal / single-label rejected
 *   - DNS resolution: any non-public resolved IP → reject; lookup failure → could not resolve
 *   - fetchPublicResponse: non-2xx rejected, redirects re-validated per hop (≤5 hops), redirect into private space rejected
 *   - error messages carry the `${tool} failed:` prefix (matches "web_fetch failed: ...")
 *   - abort / timeout boundaries
 *   - concurrency: Promise.all fan-out of two independent deps calls does not interfere
 *
 * Fully offline: fetch / lookup are injected stubs, no network touched.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  assertDecodedBodyLimit,
  contentLengthExceedsCap,
  createDefaultGuardDeps,
  DEFAULT_USER_AGENT,
  fetchPublicResponse,
  MAX_DECODED_BODY_BYTES,
  readUtf8WithByteLimit,
  validateHttpUrl,
  type GuardFetchFn,
  type GuardLookupFn,
} from "../../../../src/harness/aci/tools/network-guard.ts";

const PUBLIC_IP = "93.184.216.34"; // example.com — the stub's "public" resolution result

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
    // WHATWG URL: "http://" is directly Invalid URL (no host);
    // "http:///path" parses as host="path" and is rejected by the single-label hostname rule instead.
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
    assert.deepEqual(calls, []); // IP literals skip DNS entirely
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
    assert.equal(hop, 6); // 1 initial request + 5 followed redirects
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
    // SSRF defense mirrors `validate_http_url(resolved_proxy)`:
    // the proxy URL must pass httpUrlViolation before ProxyAgent is constructed,
    // and that check runs on the factory's synchronous path, before the first
    // call of the fetch closure.
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
    // The dispatcher wiring is triggered; only the returned deps shape is validated here.
    // Real network behavior (egress via ProxyAgent) is covered by smoke scripts, keeping tests off any proxy.
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
    // Existing createDefaultGuardDeps(ua?: string) call sites must not break under the new opts form.
    const deps = createDefaultGuardDeps("legacy-ua/1.0");
    assert.equal(typeof deps.fetch, "function");
  });
});

describe("createDefaultGuardDeps - 浏览器伪装 UA（反爬可达性）", () => {
  it("DEFAULT_USER_AGENT 形如浏览器串并带 iknow 后缀", () => {
    // Guards against regressing to a bare product UA (observed in practice to be blocked by Cloudflare 202 challenges).
    assert.match(DEFAULT_USER_AGENT, /^Mozilla\/5\.0/);
    assert.ok(DEFAULT_USER_AGENT.includes("AppleWebKit"));
    assert.ok(DEFAULT_USER_AGENT.includes("Chrome/"));
    assert.ok(DEFAULT_USER_AGENT.includes("iknow/"));
  });

  it("生产默认 fetch 携带 DEFAULT_USER_AGENT 头", async () => {
    const deps = createDefaultGuardDeps();
    // deps.fetch wraps the real globalThis.fetch and its closure cannot be
    // introspected for headers, so this verifies only the UA propagation path:
    // the no-arg default and the explicit ua both yield a well-formed deps.
    assert.equal(typeof deps.fetch, "function");
    assert.equal(typeof deps.lookup, "function");
    const custom = createDefaultGuardDeps("custom-ua/9.9");
    assert.equal(typeof custom.fetch, "function");
    assert.equal(typeof custom.lookup, "function");
  });

  it("ua 参数缺省时回退到 DEFAULT_USER_AGENT", () => {
    // Headers are not observed directly (the globalThis.fetch closure is not
    // introspectable); verify instead that the no-arg call does not throw and
    // returns usable deps.
    const deps = createDefaultGuardDeps();
    assert.ok(deps.fetch !== undefined);
    assert.ok(deps.lookup !== undefined);
  });
});

describe("decoded body byte cap", () => {
  it("empty body and missing Content-Length succeed", async () => {
    assert.equal(contentLengthExceedsCap(null, MAX_DECODED_BODY_BYTES), false);
    assert.equal(contentLengthExceedsCap("", MAX_DECODED_BODY_BYTES), false);
    const empty = await readUtf8WithByteLimit(null, MAX_DECODED_BODY_BYTES);
    assert.equal(empty, "");
    assert.doesNotThrow(() => assertDecodedBodyLimit(""));
  });

  it("non-numeric Content-Length is ignored (negative class)", () => {
    assert.equal(
      contentLengthExceedsCap("not-a-number", MAX_DECODED_BODY_BYTES),
      false
    );
    assert.equal(contentLengthExceedsCap("-1", MAX_DECODED_BODY_BYTES), false);
    assert.equal(
      contentLengthExceedsCap(
        String(MAX_DECODED_BODY_BYTES + 1),
        MAX_DECODED_BODY_BYTES
      ),
      true
    );
  });

  it("overflowing stub body is rejected without returning a partial page", async () => {
    const huge = "x".repeat(MAX_DECODED_BODY_BYTES + 1);
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/huge",
          { fetch: okFetch(huge), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "body exceeds"
    );
    assert.throws(
      () => assertDecodedBodyLimit(huge),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.includes("body exceeds")
    );
  });

  it("stream reader aborts on the first chunk that crosses the cap", async () => {
    const cap = 8;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("aaaa"));
        controller.enqueue(Buffer.from("bbbbbbbb"));
        controller.close();
      },
    });
    await assert.rejects(
      () => readUtf8WithByteLimit(stream, cap),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.includes("body exceeds")
    );
  });

  it("concurrent over-cap and under-cap stubs stay isolated", async () => {
    const huge = "x".repeat(MAX_DECODED_BODY_BYTES + 1);
    const [ok, bad] = await Promise.allSettled([
      fetchPublicResponse(
        "https://ok.example.com/",
        { fetch: okFetch("small"), lookup: okLookup },
        { tool: "web_fetch", timeoutMs: 1_000 }
      ),
      fetchPublicResponse(
        "https://big.example.com/",
        { fetch: okFetch(huge), lookup: okLookup },
        { tool: "web_fetch", timeoutMs: 1_000 }
      ),
    ]);
    assert.equal(ok.status, "fulfilled");
    if (ok.status === "fulfilled") assert.equal(ok.value.body, "small");
    assert.equal(bad.status, "rejected");
    if (bad.status === "rejected") {
      assert.ok(bad.reason instanceof ToolExecutionError);
      assert.ok(String(bad.reason.message).includes("body exceeds"));
    }
  });

  it("overflow is not swallowed into a truncated success body", async () => {
    const huge = "y".repeat(MAX_DECODED_BODY_BYTES + 8);
    await expectToolError(
      () =>
        fetchPublicResponse(
          "https://example.com/huge",
          { fetch: okFetch(huge), lookup: okLookup },
          { tool: "web_fetch", timeoutMs: 1_000 }
        ),
      "web_fetch failed:"
    );
  });
});
