/**
 * ACI web backend 能力表：一个后端名 → 搜走谁 / 抓走谁。
 *
 * 回落只在装配期判定；传输失败不在本表。非法 id 不在本函数（env fail-loud）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import { resolveWebCapability } from "../../src/config/aci-web-backend.ts";

describe("resolveWebCapability", () => {
  it("unset / bing → default search + local fetch", () => {
    assert.deepEqual(resolveWebCapability({}), {
      searchEngine: "default",
      fetchEngine: "local",
    });
    assert.deepEqual(resolveWebCapability({ backend: "bing" }), {
      searchEngine: "default",
      fetchEngine: "local",
    });
  });

  it("tavily / brave are missing search and fetch even with keys", () => {
    assert.deepEqual(
      resolveWebCapability({ backend: "tavily", tavilyApiKey: "tvly-test" }),
      { searchEngine: "default", fetchEngine: "local" }
    );
    assert.deepEqual(
      resolveWebCapability({ backend: "brave", braveApiKey: "bsa-test" }),
      { searchEngine: "default", fetchEngine: "local" }
    );
  });

  it("exa without a usable key is missing both sides", () => {
    assert.deepEqual(resolveWebCapability({ backend: "exa" }), {
      searchEngine: "default",
      fetchEngine: "local",
    });
    assert.deepEqual(
      resolveWebCapability({ backend: "exa", exaApiKey: "   " }),
      { searchEngine: "default", fetchEngine: "local" }
    );
  });

  it("only exa + key is search and fetch", () => {
    assert.deepEqual(
      resolveWebCapability({ backend: "exa", exaApiKey: "exa-test" }),
      { searchEngine: "exa", fetchEngine: "exa" }
    );
  });

  it("does not treat a vendor HTTP failure as missing capability", () => {
    const assembled = resolveWebCapability({
      backend: "exa",
      exaApiKey: "exa-test",
    });
    assert.equal(assembled.searchEngine, "exa");
    assert.equal(assembled.fetchEngine, "exa");
  });

  it("this round has no Tavily extract or Brave fetch client", () => {
    const fetchSrc = readFileSync(
      new URL("../../src/harness/aci/tools/web-fetch.ts", import.meta.url),
      "utf8"
    );
    const contentsSrc = readFileSync(
      new URL("../../src/harness/aci/tools/exa-contents.ts", import.meta.url),
      "utf8"
    );
    assert.ok(!fetchSrc.includes("api.tavily.com"));
    assert.ok(!fetchSrc.includes("api.search.brave.com"));
    assert.ok(!contentsSrc.includes("tavily"));
    assert.ok(!contentsSrc.includes("brave"));
  });

  it("SC10 probe binds AbortSignal.timeout to SEARCH/FETCH module constants", () => {
    const probeSrc = readFileSync(
      new URL("../../scripts/aci-web-backend-exa-probe.ts", import.meta.url),
      "utf8"
    );
    assert.match(probeSrc, /AbortSignal\.timeout\(SEARCH_TIMEOUT_MS\)/);
    assert.match(probeSrc, /AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
    assert.match(probeSrc, /SEARCH_TIMEOUT_MS/);
    assert.match(probeSrc, /FETCH_TIMEOUT_MS/);
  });

  it("SC10 probe fetch PASS requires a non-empty body on the contents path", () => {
    const probeSrc = readFileSync(
      new URL("../../scripts/aci-web-backend-exa-probe.ts", import.meta.url),
      "utf8"
    );
    assert.match(probeSrc, /UNTRUSTED_BANNER/);
    assert.match(probeSrc, /api\.exa\.ai\/contents/);
    assert.match(probeSrc, /trim\(\)\.length\s*>\s*0/);
  });

  it("loadFetchResponse takes one options object (S6 param pack)", () => {
    const fetchSrc = readFileSync(
      new URL("../../src/harness/aci/tools/web-fetch.ts", import.meta.url),
      "utf8"
    );
    assert.match(fetchSrc, /function loadFetchResponse\(\s*\{/);
  });
});
