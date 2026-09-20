/**
 * Tests for bm25.ts (scoreMemoryEntries — keyword heuristic scoring).
 *
 * Coverage (bm25 half): title hits weighted 2x / body hits weighted 1x /
 * importance weighting / recency_boost / empty query -> [] / single-character
 * queries skipped / stable ordering.
 *
 * Same heuristics as the Python prototype (metadata hit 2x + body 1x +
 * importance weighting + recency_boost + stable ordering). bm25 is a pure function — no IO.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  scoreMemoryEntries,
  tokenize,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

// -- fixtures ----------------------------------------------------------------

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

// -- empty / too-short queries ----------------------------------------------

describe("scoreMemoryEntries — degenerate queries", () => {
  it("returns [] for an empty query", () => {
    assert.deepEqual(scoreMemoryEntries("", [entry()]), []);
    assert.deepEqual(scoreMemoryEntries("   ", [entry()]), []);
  });

  it("returns [] for a single-character query", () => {
    assert.deepEqual(scoreMemoryEntries("a", [entry()]), []);
  });

  it("returns [] for empty entries", () => {
    assert.deepEqual(scoreMemoryEntries("bar", []), []);
  });
});

// -- shared CJK tokenization -------------------------------------------------

describe("memory tokenize — CJK runs and ASCII compatibility", () => {
  it("emits overlapping bigrams for a CJK run", () => {
    assert.deepEqual(tokenize("中文文档"), ["中文", "文文", "文档"]);
  });

  it("emits a single character for a one-character CJK run", () => {
    assert.deepEqual(tokenize("中"), ["中"]);
  });

  it("keeps ASCII tokenization unchanged", () => {
    assert.deepEqual(tokenize("a x ab foo_bar 123"), ["ab", "foo_bar", "123"]);
  });

  it("scores a pure-Chinese query against a pure-Chinese entry", () => {
    const [result] = scoreMemoryEntries(
      "中文文档",
      [entry({ title: "中文文档", body: "中文文档内容" })],
      { nowMs: Date.parse("2026-01-01T00:00:00.000Z") }
    );
    assert.ok(result !== undefined);
    assert.ok(result!.score > 0);
  });
});

// -- weighting ---------------------------------------------------------------

describe("scoreMemoryEntries — title vs body weighting", () => {
  it("title hit contributes 2x a body hit (delta = 1.0 weight)", () => {
    // Same importance + updated_at on both → importance/recency cancel, so
    // the score delta is exactly the hit-weight difference (title 2 − body 1).
    const titleHit = entry({
      title: "deploy pipeline",
      body: "irrelevant words",
    });
    const bodyHit = entry({
      title: "irrelevant",
      body: "deploy pipeline here",
    });
    const [t] = scoreMemoryEntries("deploy", [titleHit]);
    const [b] = scoreMemoryEntries("deploy", [bodyHit]);
    assert.ok(t !== undefined && b !== undefined);
    assert.ok(t!.score > b!.score, "title hit must outscore body hit");
    assert.ok(
      Math.abs(t!.score - b!.score - 1.0) < 1e-6,
      "title hit − body hit ≈ 1.0 (2x vs 1x weight)"
    );
  });

  it("importance weights the score (×0.4 additive)", () => {
    const low = entry({ title: "deploy", importance: 1 });
    const high = entry({ title: "deploy", importance: 5 });
    const [l] = scoreMemoryEntries("deploy", [low]);
    const [h] = scoreMemoryEntries("deploy", [high]);
    assert.ok(l !== undefined && h !== undefined);
    assert.ok(h!.score > l!.score, "higher importance must score higher");
  });

  it("returns the matched entry with a positive score", () => {
    const [out] = scoreMemoryEntries("deploy", [entry({ title: "deploy" })]);
    assert.ok(out !== undefined);
    assert.equal(out!.entry.id, "mem-1");
    assert.ok(out!.score > 0);
  });
});

// -- recency boost -----------------------------------------------------------

describe("scoreMemoryEntries — recency boost", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  it("a newer entry scores higher than an older one (same content)", () => {
    const fresh = entry({
      title: "deploy",
      updated_at: iso(now),
      id: "fresh",
    });
    const stale = entry({
      title: "deploy",
      updated_at: iso(now - 30 * 24 * 3600 * 1000),
      id: "stale",
    });
    const results = scoreMemoryEntries("deploy", [fresh, stale], {
      nowMs: now,
    });
    const rank = new Map(results.map((r) => [r.entry.id, r.score]));
    assert.ok(
      rank.get("fresh")! > rank.get("stale")!,
      "fresh must outscore stale"
    );
  });

  it("recency is deterministic for a fixed reference time", () => {
    const a = scoreMemoryEntries("deploy", [entry({ title: "deploy" })], {
      nowMs: 1_000_000,
    });
    const b = scoreMemoryEntries("deploy", [entry({ title: "deploy" })], {
      nowMs: 1_000_000,
    });
    assert.deepEqual(a, b);
  });
});

// -- stable sort -------------------------------------------------------------

describe("scoreMemoryEntries — stable ordering", () => {
  it("ties keep input order (stable sort)", () => {
    const a = entry({ id: "a", title: "deploy", importance: 1 });
    const b = entry({ id: "b", title: "deploy", importance: 1 });
    // Same score (identical title/importance/recency) → input order preserved.
    const out = scoreMemoryEntries("deploy", [a, b], { nowMs: 0 });
    assert.deepEqual(
      out.map((r) => r.entry.id),
      ["a", "b"]
    );
  });

  it("sorts higher score first", () => {
    const low = entry({ id: "low", title: "deploy", importance: 1 });
    const high = entry({ id: "high", title: "deploy", importance: 9 });
    const out = scoreMemoryEntries("deploy", [low, high], { nowMs: 0 });
    assert.equal(out[0]!.entry.id, "high");
    assert.equal(out[1]!.entry.id, "low");
  });
});
