/**
 * Golden-set lock for web_search (discover) vs web_fetch (read).
 *
 * Invariant: three individually runnable fixtures exist with decidable
 * inputs (specs/960-web-discover-vs-read.md SC1–SC3). First-tool hard
 * gate is the real-LLM sibling under archive/tests-real-llm (SC5).
 * This file stays offline so default `npm test` does not call a model.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createWebFetchTool } from "../../../../src/harness/aci/tools/web-fetch.ts";
import { createWebSearchTool } from "../../../../src/harness/aci/tools/web-search.ts";
import {
  DISCOVER_VS_READ_FIXTURES,
  fixtureById,
  httpUrlsIn,
  type DiscoverVsReadFixture,
} from "./web-discover-vs-read.fixtures.ts";

describe("web discover vs read golden set (fixtures)", () => {
  it("contains exactly three individually named fixtures", () => {
    assert.equal(DISCOVER_VS_READ_FIXTURES.length, 3);
    const ids = DISCOVER_VS_READ_FIXTURES.map((f) => f.id);
    assert.deepEqual(ids, [
      "sc1-search-no-url",
      "sc2-read-given-url",
      "sc3-empty-search-not-guess-fetch",
    ]);
  });

  const sc1 = fixtureById("sc1-search-no-url");
  it(sc1.title, () => {
    assertFixtureRunnable(sc1);
    assert.equal(httpUrlsIn(sc1.userPrompt).length, 0);
    assert.match(sc1.userPrompt, /search|news/i);
  });

  const sc2 = fixtureById("sc2-read-given-url");
  it(sc2.title, () => {
    assertFixtureRunnable(sc2);
    const urls = httpUrlsIn(sc2.userPrompt);
    assert.ok(urls.length >= 1, "SC2 prompt must include an http(s) URL");
    assert.match(urls[0]!, /^https?:\/\//i);
    assert.match(sc2.userPrompt, /read/i);
  });

  const sc3 = fixtureById("sc3-empty-search-not-guess-fetch");
  it(sc3.title, () => {
    assertFixtureRunnable(sc3);
    assert.equal(httpUrlsIn(sc3.userPrompt).length, 0);
    assert.match(sc3.userPrompt, /search/i);
  });
});

describe("web discover vs read descriptions (SC4)", () => {
  it("web_search describes discover-by-keyword, not fetch-on-each-URL pairing", () => {
    const description = createWebSearchTool().description;
    assert.match(description, /\b(search|discover)\b/i);
    assert.doesNotMatch(
      description,
      /Pair with web_fetch on each returned URL/i
    );
    assert.doesNotMatch(description, /before reading them with web_fetch/i);
  });

  it("web_fetch describes read-when-you-have-the-URL, not skip-search-as-default", () => {
    const description = createWebFetchTool().description;
    assert.match(description, /when you have the URL/i);
    assert.match(description, /\b(fetch|read)\b/i);
    assert.doesNotMatch(description, /skip search/i);
  });
});

function assertFixtureRunnable(fixture: DiscoverVsReadFixture): void {
  assert.ok(fixture.title.length > 0);
  assert.ok(fixture.userPrompt.trim().length > 0);
  assert.ok(
    fixture.spec === "SC1" || fixture.spec === "SC2" || fixture.spec === "SC3"
  );
}
