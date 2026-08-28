/**
 * memory_prefetch (specs/auto-memory-low-trust-read.md SC4–SC5).
 *
 * Same scorer as memory_recall; zero lexical hits never join; max 5; char cap
 * drops trailing hits rather than overflowing.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MEMORY_ADVISORY_PREFIX,
  MEMORY_PREFETCH_CHAR_CAP,
  MEMORY_PREFETCH_MAX_HITS,
  formatPrefetchOverlay,
  selectPrefetchHits,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

const entry = (overrides?: Partial<MemoryEntryV1>): MemoryEntryV1 => ({
  id: "mem-1",
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Use bar()",
  body: "Calling bar() is the supported path.",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("selectPrefetchHits", () => {
  it("keeps lexically overlapping live entries and drops a zero-overlap high-importance note", () => {
    const relatedA = entry({
      id: "a",
      title: "Deploy pipeline",
      body: "ship the deploy pipeline on Fridays",
      importance: 1,
    });
    const relatedB = entry({
      id: "b",
      title: "Rollback notes",
      body: "deploy rollback uses the pipeline flag",
      importance: 1,
    });
    const noise = entry({
      id: "noise",
      title: "Favorite snack",
      body: "always keep pretzels at the desk",
      importance: 9,
    });
    const hits = selectPrefetchHits("deploy pipeline", [
      noise,
      relatedA,
      relatedB,
    ]);
    const ids = hits.map((h) => h.entry.id);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
    assert.ok(!ids.includes("noise"));
    assert.ok(hits.length <= MEMORY_PREFETCH_MAX_HITS);
  });

  it("returns no hits for an empty or punctuation-only query", () => {
    const pool = [entry({ title: "deploy pipeline", body: "deploy" })];
    assert.deepEqual(selectPrefetchHits("", pool), []);
    assert.deepEqual(selectPrefetchHits("   ", pool), []);
    assert.deepEqual(selectPrefetchHits("...", pool), []);
    assert.deepEqual(selectPrefetchHits("!!!", pool), []);
  });

  it("caps the hit count at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      entry({
        id: `m${i}`,
        title: `Match ${i} sharedtoken`,
        body: "sharedtoken body",
      })
    );
    const hits = selectPrefetchHits("sharedtoken", many);
    assert.equal(hits.length, MEMORY_PREFETCH_MAX_HITS);
  });

  it("drops disabled entries and already-promoted ids", () => {
    const live = entry({ id: "live", title: "deploy", body: "deploy" });
    const dead = entry({
      id: "dead",
      disabled: true,
      title: "deploy",
      body: "deploy",
    });
    const promoted = entry({ id: "promoted", title: "deploy", body: "deploy" });
    const hits = selectPrefetchHits("deploy", [live, dead, promoted], {
      promotedIds: new Set(["promoted"]),
    });
    assert.deepEqual(
      hits.map((h) => h.entry.id),
      ["live"]
    );
  });

  it("stops adding hits once the character cap would be exceeded", () => {
    const bulky = entry({
      id: "bulky",
      title: "deploy",
      body: "x".repeat(MEMORY_PREFETCH_CHAR_CAP),
      importance: 1,
    });
    const extra = entry({
      id: "extra",
      title: "deploy",
      body: "yy",
      importance: 1,
    });
    const hits = selectPrefetchHits("deploy", [bulky, extra], {
      nowMs: 0,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.entry.id, "bulky");
  });
});

describe("formatPrefetchOverlay", () => {
  it("starts with the locked English advisory line", () => {
    const hits = selectPrefetchHits("bar", [entry()]);
    const text = formatPrefetchOverlay(hits);
    assert.ok(text.startsWith(MEMORY_ADVISORY_PREFIX));
    assert.ok(text.includes("### Use bar()"));
    assert.ok(text.includes("Calling bar() is the supported path."));
  });

  it("returns an empty string when there are no hits", () => {
    assert.equal(formatPrefetchOverlay([]), "");
  });
});
