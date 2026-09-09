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

  it("SC1: no URL, search/news request → first tool web_search", () => {
    const fixture = fixtureById("sc1-search-no-url");
    assertFixtureRunnable(fixture);
    assert.equal(httpUrlsIn(fixture.userPrompt).length, 0);
    assert.match(fixture.userPrompt, /search|news/i);
  });

  it("SC2: user already gave http(s) URL and asked to read page → first tool MAY be web_fetch", () => {
    const fixture = fixtureById("sc2-read-given-url");
    assertFixtureRunnable(fixture);
    const urls = httpUrlsIn(fixture.userPrompt);
    assert.ok(urls.length >= 1, "SC2 prompt must include an http(s) URL");
    assert.match(urls[0]!, /^https?:\/\//i);
    assert.match(fixture.userPrompt, /read/i);
  });

  it("SC3: after search returns zero results, next step is NOT a guessed-URL web_fetch", () => {
    const fixture = fixtureById("sc3-empty-search-not-guess-fetch");
    assertFixtureRunnable(fixture);
    assert.equal(httpUrlsIn(fixture.userPrompt).length, 0);
    assert.match(fixture.userPrompt, /search/i);
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
