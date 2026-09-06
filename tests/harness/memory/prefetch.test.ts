/**
 * memory_prefetch (specs/auto-memory-low-trust-read.md SC4–SC5).
 *
 * Same scorer as memory_recall; zero lexical hits never join; max 5; char cap
 * drops trailing hits rather than overflowing.
 *
 * ADR-0044 / specs/promote-bodies-never-enter-system.md: the prefetch must
 * NOT exclude entries by promote eligibility (`eligibleForPromote` /
 * `promotedIds`). The system no longer renders a promote block, so excluding
 * here would silently drop eligible entries from the user-side overlay.
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_ADVISORY_PREFIX,
  MEMORY_PREFETCH_DISCIPLINE,
  MEMORY_PREFETCH_CHAR_CAP,
  MEMORY_PREFETCH_END,
  MEMORY_PREFETCH_MAX_HITS,
  applyHostPrefetch,
  attachPrefetchOverlay,
  buildMemoryPrefetchOverlay,
  extractInjectedMemoryIds,
  formatPrefetchOverlay,
  recoverInjectedMemoryIds,
  recordInjectedMemoryIds,
  selectPrefetchHits,
  serializeMemoryEntry,
  stripPrefetchOverlay,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

const written: string[] = [];
afterEach(async () => {
  await Promise.all(
    written.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

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

  it("drops disabled entries only — promote eligibility is no longer an exclusion (ADR-0044)", () => {
    const live = entry({ id: "live", title: "deploy", body: "deploy" });
    const dead = entry({
      id: "dead",
      disabled: true,
      title: "deploy",
      body: "deploy",
    });
    const promotable = entry({
      id: "promotable",
      title: "deploy",
      body: "deploy",
    });
    const hits = selectPrefetchHits("deploy", [live, dead, promotable]);
    assert.deepEqual(
      hits.map((h) => h.entry.id).sort(),
      ["live", "promotable"],
      "disabled entries are still excluded; eligible entries are not"
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

  it("carries the no-procedure discipline line: injected bodies are records, not this turn's instructions", () => {
    // 不变式（SSOT: specs/casual-ask-context-hygiene.md 纪律句语义 + 本票
    // spec 修订把 MEMORY_PREFETCH_DISCIPLINE 纳入锁定）：overlay 正文是
    // 过去工作的记录而非本轮指令——convention 条目描述的流程不得因词面
    // 撞上问句就被执行。锁定文本按全文匹配，与 catalog 纪律句同强度。
    const hits = selectPrefetchHits("bar", [entry()]);
    const text = formatPrefetchOverlay(hits);
    assert.ok(text.includes(MEMORY_PREFETCH_DISCIPLINE));
    assert.ok(
      text.startsWith(
        `${MEMORY_ADVISORY_PREFIX}\n\n${MEMORY_PREFETCH_DISCIPLINE}\n\n### `
      )
    );
  });

  it("returns an empty string when there are no hits", () => {
    assert.equal(formatPrefetchOverlay([]), "");
  });
});

// ADR-0044 SC3: a query overlapping an entry whose usage.json proves promote
// eligibility must surface that entry in the overlay (the old code dropped it).
describe("buildMemoryPrefetchOverlay — promote eligibility is not an exclusion (ADR-0044)", () => {
  it("surfaces an eligible-by-usage entry on lexical overlap, even with disabled peers", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prefetch-promote-"));
    written.push(tmp);
    await writeFile(
      join(tmp, "promotable.md"),
      serializeMemoryEntry(
        entry({
          id: "promotable",
          title: "Deploy pipeline",
          body: "ship the deploy pipeline on Fridays",
        })
      )
    );
    await writeFile(
      join(tmp, "disabled.md"),
      serializeMemoryEntry(
        entry({
          id: "disabled",
          disabled: true,
          title: "Deploy pipeline",
          body: "ship the deploy pipeline on Fridays",
        })
      )
    );
    // ≥2 distinct sessions → eligible by ADR-0009 D3 (before ADR-0044, the
    // prefetch would have dropped this exact entry from the overlay).
    await writeFile(
      join(tmp, "usage.json"),
      JSON.stringify({
        entries: {
          promotable: { recall_count: 4, sessions: ["s1", "s2"] },
        },
      })
    );
    const overlay = await buildMemoryPrefetchOverlay({
      memoryDir: tmp,
      query: "deploy pipeline",
    });
    assert.ok(
      overlay.includes("### Deploy pipeline"),
      "eligible entry must appear in the overlay"
    );
    // disabled still does not surface.
    const hits = [...overlay.matchAll(/^### /gm)];
    assert.equal(hits.length, 1, "disabled entry must remain excluded");
  });
});

describe("applyHostPrefetch", () => {
  it("returns the original user text when no overlay function is wired", async () => {
    assert.equal(await applyHostPrefetch("hello", undefined), "hello");
  });

  it("prepends a successful overlay to the user text, not a system string", async () => {
    const out = await applyHostPrefetch("hello", async () => "OVERLAY");
    assert.equal(out, `OVERLAY${MEMORY_PREFETCH_END}hello`);
  });

  it("returns the original user text when overlay throws", async () => {
    const out = await applyHostPrefetch("hello", async () => {
      throw new Error("disk down");
    });
    assert.equal(out, "hello");
  });
});

describe("stripPrefetchOverlay", () => {
  it("returns the typed query after the end marker", () => {
    const full = attachPrefetchOverlay("查一下今天AI新闻", "OVERLAY");
    assert.equal(stripPrefetchOverlay(full), "查一下今天AI新闻");
  });

  it("strips a legacy overlay without the end marker", () => {
    const overlay = formatPrefetchOverlay(selectPrefetchHits("bar", [entry()]));
    const full = `${overlay}\n\n查一下今天AI新闻`;
    assert.equal(stripPrefetchOverlay(full), "查一下今天AI新闻");
    assert.ok(!stripPrefetchOverlay(full).includes(MEMORY_ADVISORY_PREFIX));
  });
});

describe("selectPrefetchHits session-level dedup (excludeIds)", () => {
  it("excludes already-injected ids before scoring so the next-best hit fills the freed slot", () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      entry({
        id: `m${i}`,
        title: `Match ${i} sharedtoken`,
        body: "sharedtoken body",
      })
    );
    const hits = selectPrefetchHits("sharedtoken", pool, {
      excludeIds: new Set(["m0"]),
    });
    const ids = hits.map((h) => h.entry.id);
    // Dedup removal must not consume one of the 5 slots.
    assert.equal(hits.length, MEMORY_PREFETCH_MAX_HITS);
    assert.ok(!ids.includes("m0"), "injected id must be gone");
    assert.ok(
      ids.includes("m5"),
      "the entry that lost its slot earlier must backfill"
    );
  });

  it("collapses to an empty overlay once every candidate is already injected and attach stays byte-identical", async () => {
    const pool = [entry({ id: "only", title: "deploy", body: "deploy" })];
    const overlay = await buildMemoryPrefetchOverlay({
      memoryDir: "/nonexistent-iknow-t1-dedup",
      query: "deploy",
      entries: pool,
      excludeIds: new Set(["only"]),
    });
    assert.equal(overlay, "");
    const userText = "typed query 查询原文";
    assert.equal(attachPrefetchOverlay(userText, overlay), userText);
  });

  it("dedup keys on id only so an updated_at bump does not re-inject", () => {
    // Same memory id across an in-conversation update: the bumped revision
    // shares nothing lexically with the injected one, so an id+updated_at (or
    // content) fingerprint would let it back in. Keying on id alone must
    // still drop it (契约: 条目更新不重灌).
    const injectedRevision = entry({
      id: "mem-1",
      title: "Favorite snack",
      body: "always keep pretzels at the desk",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const bumpedRevision = entry({
      id: "mem-1",
      title: "deploy pipeline",
      body: "ship the deploy pipeline on Fridays",
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    const query = "deploy pipeline";
    assert.deepEqual(
      selectPrefetchHits(query, [injectedRevision, bumpedRevision], {
        excludeIds: new Set(["mem-1"]),
      }),
      [],
      "both revisions share the id, so both must be excluded"
    );
    // Control: without the exclusion the bumped revision is eligible (1 hit).
    const control = selectPrefetchHits(query, [
      injectedRevision,
      bumpedRevision,
    ]);
    assert.deepEqual(
      control.map((h) => h.entry.id),
      ["mem-1"]
    );
    assert.equal(control.length, 1);
  });
});

describe("extractInjectedMemoryIds", () => {
  const blockFor = (id: string): string =>
    `### T\nid: ${id}\ntype: note\nimportance: 1\nttl_days: 0\ndisabled: false\nsupersedes: null\nupdated_at: 2026-01-01T00:00:00.000Z\n\nbody for ${id}`;

  it("collects ids from multiple advisory blocks that carry end markers", () => {
    const text =
      `${MEMORY_ADVISORY_PREFIX}\n\n${blockFor("mem-a")}` +
      `${MEMORY_PREFETCH_END}first query` +
      `${MEMORY_ADVISORY_PREFIX}\n\n${blockFor("mem-b")}` +
      `${MEMORY_PREFETCH_END}second query`;
    assert.deepEqual([...extractInjectedMemoryIds(text)].sort(), [
      "mem-a",
      "mem-b",
    ]);
  });

  it("scans a block to the next advisory prefix when the end marker is missing", () => {
    const text =
      `${MEMORY_ADVISORY_PREFIX}\n\n${blockFor("mem-a")}\n\n` +
      `${MEMORY_ADVISORY_PREFIX}\n\n${blockFor("mem-b")}`;
    assert.deepEqual([...extractInjectedMemoryIds(text)].sort(), [
      "mem-a",
      "mem-b",
    ]);
  });

  it("returns an empty set when a block carries no id lines", () => {
    const text = `${MEMORY_ADVISORY_PREFIX}\n\n### T\nno metadata here\n\nbody${MEMORY_PREFETCH_END}q`;
    assert.equal(extractInjectedMemoryIds(text).size, 0);
    assert.equal(extractInjectedMemoryIds("plain query, no overlay").size, 0);
  });

  it("never throws on malformed input", () => {
    const malformedInputs = [
      "",
      "   ",
      MEMORY_ADVISORY_PREFIX,
      `${MEMORY_ADVISORY_PREFIX}${MEMORY_PREFETCH_END}`,
      `${MEMORY_ADVISORY_PREFIX}\n\nid:\n\nid:   \n\n### x`,
      "\n\nid: ghost\n\n",
    ];
    for (const malformed of malformedInputs) {
      const ids = extractInjectedMemoryIds(malformed);
      assert.ok(ids instanceof Set);
    }
    // Ids outside advisory blocks are never collected.
    assert.ok(!extractInjectedMemoryIds("\n\nid: ghost\n\n").has("ghost"));
  });
});

describe("recoverInjectedMemoryIds (resume recovery)", () => {
  const overlay = `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: mem-a\n\nbody${MEMORY_PREFETCH_END}`;

  it("collects ids from user text blocks only", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: `${overlay}resumed query` }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: `${overlay}assistant must be ignored` },
        ],
      },
      { role: "user", content: [{ type: "text", text: "no overlay here" }] },
      { role: "user", content: [{ type: "tool_result", content: "x" }] },
    ];
    assert.deepEqual([...recoverInjectedMemoryIds(messages)], ["mem-a"]);
  });

  it("tolerates malformed history with an empty set instead of throwing", () => {
    assert.equal(recoverInjectedMemoryIds(undefined).size, 0);
    assert.equal(
      recoverInjectedMemoryIds([
        null,
        {},
        { role: "user", content: "not-an-array" },
        { role: "user", content: [{ type: "text" }] },
      ]).size,
      0
    );
  });
});

describe("recordInjectedMemoryIds (post-attach bookkeeping)", () => {
  it("merges ids only when the attach result actually carries an overlay", () => {
    const overlay = `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: mem-a\n\nbody${MEMORY_PREFETCH_END}`;
    const injected = new Set<string>();
    // Identity fallback (empty overlay / failed overlay fn) adds nothing.
    recordInjectedMemoryIds(injected, "plain typed query");
    assert.equal(injected.size, 0);
    recordInjectedMemoryIds(injected, `${overlay}typed query`);
    assert.deepEqual([...injected], ["mem-a"]);
    // Legacy shape without the end marker still counts via the prefix line.
    const legacy = new Set<string>();
    recordInjectedMemoryIds(
      legacy,
      `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: legacy\n`
    );
    assert.ok(legacy.has("legacy"));
  });

  it("stops recording at the end marker so pasted advisory-shaped user text is ignored", () => {
    const realOverlay =
      `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: mem-real\n\nbody` +
      `${MEMORY_PREFETCH_END}`;
    // Advisory-shaped content inside the user's own text, after the marker.
    const pastedQuery =
      `please quote ${MEMORY_ADVISORY_PREFIX}\n\n### Fake\nid: fake-1\n\n` +
      "pretend memory body";
    const injected = new Set<string>();
    recordInjectedMemoryIds(injected, `${realOverlay}${pastedQuery}`);
    assert.ok(injected.has("mem-real"));
    assert.ok(
      !injected.has("fake-1"),
      "user-pasted advisory blocks after the marker must not poison the set"
    );
  });
});
