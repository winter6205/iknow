/**
 * auto-memory T2: gc.ts tests (planMemoryGc / runMemoryGc).
 *
 * Spec: specs/auto-memory.md D3 + ADR-0031 Decision 4 — mechanical GC with
 * exactly three rules (TTL disable / supersede soft-disable / cap utility
 * eviction), soft-disable only (never deletes a file), idempotent on repeat.
 *
 * Five boundary classes (ACR defensive-contract-validator):
 *   empty     — empty store / no candidates → no-op plan
 *   negative  — negative ttl_days / negative importance / non-positive cap
 *   overflow  — active entries beyond the cap → lowest utility evicted
 *   concurrent— a memory_save landing mid-GC is neither lost nor half-written
 *   exception — malformed entry file skipped, GC still completes
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryError,
  MemoryIOError,
  listStoreEntries,
  memoryEntryUtility,
  parseMemoryEntry,
  planMemoryGc,
  recordRecall,
  runMemoryGc,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";
import { createMemorySaveTool } from "../../../src/harness/memory/tools/save.ts";

// -- fixtures ----------------------------------------------------------------

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "memory-gc-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-08-26T00:00:00.000Z");

const entry = (overrides?: Partial<MemoryEntryV1>): MemoryEntryV1 => ({
  id: "mem-1",
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Use bar()",
  body: "Calling bar() is the supported path.",
  updated_at: "2026-08-25T00:00:00.000Z",
  ...overrides,
});

const daysAgo = (n: number): string =>
  new Date(NOW - n * 24 * 3600 * 1000).toISOString();

/** Write an entry to `<slug>.md` in the memory dir. */
const put = async (
  slug: string,
  overrides?: Partial<MemoryEntryV1>
): Promise<void> => {
  await writeFile(
    join(memoryDir, `${slug}.md`),
    serializeMemoryEntry(entry({ id: slug, ...overrides })),
    "utf8"
  );
};

/** Read `<slug>.md` back off disk. */
const get = async (slug: string): Promise<MemoryEntryV1> =>
  parseMemoryEntry(await readFile(join(memoryDir, `${slug}.md`), "utf8"));

/**
 * Classifier fixtures (specs/runtime-capability-memory-gate.md): the sweep
 * must disable the runtime capability observation and leave the product
 * policy `constraint` alone.
 */
const CAPABILITY = {
  title: "web_search is unavailable in this sandbox",
  body: "The sandbox DNS/SSRF benchmarking segment blocks outbound network access.",
} as const;

const POLICY = {
  type: "constraint",
  title: "Worktree policy",
  body: "隔离 ON 时 mutate 须先建 worktree。",
} as const;

// -- planMemoryGc: TTL rule --------------------------------------------------

describe("planMemoryGc — TTL rule", () => {
  it("disables an entry whose ttl_days has elapsed since updated_at", () => {
    const plan = planMemoryGc(
      [{ slug: "old", entry: entry({ ttl_days: 5, updated_at: daysAgo(10) }) }],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, [{ slug: "old", reason: "ttl_expired" }]);
  });

  it("keeps an entry still inside its ttl window", () => {
    const plan = planMemoryGc(
      [{ slug: "new", entry: entry({ ttl_days: 30, updated_at: daysAgo(3) }) }],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
    assert.deepEqual(plan.keep, ["new"]);
  });

  it("treats ttl_days = 0 as never expiring", () => {
    const plan = planMemoryGc(
      [
        {
          slug: "forever",
          entry: entry({ ttl_days: 0, updated_at: daysAgo(9999) }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
  });
});

// -- planMemoryGc: supersede rule --------------------------------------------

describe("planMemoryGc — supersede rule", () => {
  it("soft-disables the slug named by another entry's supersedes", () => {
    const plan = planMemoryGc(
      [
        { slug: "old", entry: entry({ title: "Old fact" }) },
        {
          slug: "new",
          entry: entry({ title: "New fact", supersedes: ["old"] }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, [{ slug: "old", reason: "superseded" }]);
    assert.deepEqual(plan.keep, ["new"]);
  });

  it("ignores a supersedes pointer coming from an already-disabled entry", () => {
    const plan = planMemoryGc(
      [
        { slug: "old", entry: entry({ title: "Old fact" }) },
        {
          slug: "new",
          entry: entry({
            title: "New fact",
            supersedes: ["old"],
            disabled: true,
          }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(
      plan.disable,
      [],
      "a dead pointer must not disable a live entry"
    );
  });

  it("ignores a supersedes pointer to an unknown slug", () => {
    const plan = planMemoryGc(
      [{ slug: "new", entry: entry({ supersedes: ["does-not-exist"] }) }],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
  });
});

// -- planMemoryGc: empty boundary --------------------------------------------

describe("planMemoryGc — empty boundary", () => {
  it("returns an empty plan for no candidates", () => {
    const plan = planMemoryGc([], { nowMs: NOW });
    assert.deepEqual(plan.disable, []);
    assert.deepEqual(plan.keep, []);
  });

  it("returns an empty plan when every candidate is already disabled", () => {
    const plan = planMemoryGc(
      [
        { slug: "a", entry: entry({ disabled: true }) },
        {
          slug: "b",
          entry: entry({ disabled: true, ttl_days: 1, updated_at: daysAgo(9) }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(
      plan.disable,
      [],
      "already-disabled entries are not re-disabled"
    );
    assert.deepEqual(plan.keep, []);
  });
});

// -- planMemoryGc: negative boundary -----------------------------------------

describe("planMemoryGc — negative boundary", () => {
  it("treats a negative ttl_days as never expiring", () => {
    const plan = planMemoryGc(
      [
        {
          slug: "neg",
          entry: entry({ ttl_days: -5, updated_at: daysAgo(400) }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
  });

  it("treats an unparseable updated_at as never expiring", () => {
    const plan = planMemoryGc(
      [
        {
          slug: "bad",
          entry: entry({ ttl_days: 1, updated_at: "not-a-date" }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
  });

  it("evicts negative-importance entries first under cap pressure", () => {
    const plan = planMemoryGc(
      [
        { slug: "neg", entry: entry({ importance: -3 }) },
        { slug: "pos", entry: entry({ importance: 3 }) },
      ],
      { nowMs: NOW, cap: 1 }
    );
    assert.deepEqual(plan.disable, [{ slug: "neg", reason: "cap_evicted" }]);
  });

  it("rejects a non-positive cap with a typed MemoryError", () => {
    assert.throws(
      () => planMemoryGc([], { nowMs: NOW, cap: 0 }),
      (e: unknown) =>
        e instanceof MemoryError && /cap/.test((e as Error).message)
    );
  });

  it("rejects a non-integer cap with a typed MemoryError", () => {
    assert.throws(
      () => planMemoryGc([], { nowMs: NOW, cap: 2.5 }),
      (e: unknown) => e instanceof MemoryError
    );
  });
});

// -- planMemoryGc: overflow boundary -----------------------------------------

describe("planMemoryGc — overflow boundary (cap eviction)", () => {
  it("keeps the cap-many highest-utility entries and evicts the rest", () => {
    const plan = planMemoryGc(
      [
        {
          slug: "lo",
          entry: entry({ importance: 1, updated_at: daysAgo(300) }),
        },
        {
          slug: "mid",
          entry: entry({ importance: 3, updated_at: daysAgo(30) }),
        },
        { slug: "hi", entry: entry({ importance: 5, updated_at: daysAgo(1) }) },
      ],
      { nowMs: NOW, cap: 2 }
    );
    assert.deepEqual(plan.disable, [{ slug: "lo", reason: "cap_evicted" }]);
    assert.deepEqual([...plan.keep].sort(), ["hi", "mid"]);
  });

  it("counts recall_count from the usage sidecar in the utility score", () => {
    const plan = planMemoryGc(
      [
        {
          slug: "unread",
          entry: entry({ importance: 2, updated_at: daysAgo(1) }),
        },
        {
          slug: "read",
          entry: entry({ importance: 2, updated_at: daysAgo(1) }),
        },
      ],
      {
        nowMs: NOW,
        cap: 1,
        usage: { entries: { read: { recall_count: 7, sessions: ["s1"] } } },
      }
    );
    assert.deepEqual(plan.disable, [{ slug: "unread", reason: "cap_evicted" }]);
  });

  it("does not count already-disabled or TTL-expired entries against the cap", () => {
    const plan = planMemoryGc(
      [
        { slug: "dead", entry: entry({ disabled: true, importance: 5 }) },
        {
          slug: "expired",
          entry: entry({ ttl_days: 1, updated_at: daysAgo(9), importance: 5 }),
        },
        { slug: "live", entry: entry({ importance: 1 }) },
      ],
      { nowMs: NOW, cap: 1 }
    );
    assert.deepEqual(plan.disable, [
      { slug: "expired", reason: "ttl_expired" },
    ]);
    assert.deepEqual(plan.keep, ["live"]);
  });

  it("breaks utility ties by slug so the plan is deterministic", () => {
    const twin = { importance: 2, updated_at: daysAgo(5) };
    const first = planMemoryGc(
      [
        { slug: "bbb", entry: entry(twin) },
        { slug: "aaa", entry: entry(twin) },
      ],
      { nowMs: NOW, cap: 1 }
    );
    const second = planMemoryGc(
      [
        { slug: "aaa", entry: entry(twin) },
        { slug: "bbb", entry: entry(twin) },
      ],
      { nowMs: NOW, cap: 1 }
    );
    assert.deepEqual(
      first.disable,
      second.disable,
      "input order must not change the verdict"
    );
  });
});

// -- memoryEntryUtility ------------------------------------------------------

describe("memoryEntryUtility", () => {
  it("scores importance × recency × (1 + recall_count) monotonically in importance", () => {
    const low = memoryEntryUtility(entry({ importance: 1 }), 0, NOW);
    const high = memoryEntryUtility(entry({ importance: 5 }), 0, NOW);
    assert.ok(high > low, `${high} must exceed ${low}`);
  });

  it("decays with age", () => {
    const fresh = memoryEntryUtility(entry({ updated_at: daysAgo(1) }), 0, NOW);
    const stale = memoryEntryUtility(
      entry({ updated_at: daysAgo(365) }),
      0,
      NOW
    );
    assert.ok(fresh > stale, `${fresh} must exceed ${stale}`);
  });

  it("rewards recall_count", () => {
    const cold = memoryEntryUtility(entry(), 0, NOW);
    const hot = memoryEntryUtility(entry(), 4, NOW);
    assert.ok(hot > cold, `${hot} must exceed ${cold}`);
  });
});

// -- runMemoryGc -------------------------------------------------------------

describe("runMemoryGc", () => {
  it("writes disabled: true back to the expired entry without deleting the file", async () => {
    await put("old", { ttl_days: 5, updated_at: daysAgo(10) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.disabled, [{ slug: "old", reason: "ttl_expired" }]);
    const after = await get("old");
    assert.equal(after.disabled, true);
    assert.equal(after.title, "Use bar()", "soft-disable preserves content");
  });

  it("is idempotent — a second pass disables nothing new", async () => {
    await put("old", { ttl_days: 5, updated_at: daysAgo(10) });
    await runMemoryGc(memoryDir, { nowMs: NOW });
    const second = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(second.disabled, []);
  });

  it("no-ops on an empty store", async () => {
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.disabled, []);
    assert.equal(result.scanned, 0);
  });

  it("reads recall counts from usage.json when no usage override is passed", async () => {
    await put("read", { importance: 2, updated_at: daysAgo(1) });
    await put("unread", { importance: 2, updated_at: daysAgo(1) });
    await recordRecall(memoryDir, "read", "s1");
    await recordRecall(memoryDir, "read", "s2");
    const result = await runMemoryGc(memoryDir, { nowMs: NOW, cap: 1 });
    assert.deepEqual(result.disabled, [
      { slug: "unread", reason: "cap_evicted" },
    ]);
  });

  it("skips MEMORY.md and the usage sidecar", async () => {
    await writeFile(join(memoryDir, "MEMORY.md"), "- index line\n", "utf8");
    await put("live");
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.equal(result.scanned, 1, "only <slug>.md entries are scanned");
    assert.equal(
      await readFile(join(memoryDir, "MEMORY.md"), "utf8"),
      "- index line\n"
    );
  });

  // exception boundary
  it("skips a malformed entry file and still completes", async () => {
    await writeFile(
      join(memoryDir, "broken.md"),
      "no frontmatter here",
      "utf8"
    );
    await put("old", { ttl_days: 5, updated_at: daysAgo(10) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.skipped, ["broken"]);
    assert.deepEqual(result.disabled, [{ slug: "old", reason: "ttl_expired" }]);
  });

  it("surfaces an unreadable memory dir as a typed MemoryError", async () => {
    const missing = join(memoryDir, "nope", "deeper");
    const result = await runMemoryGc(missing, { nowMs: NOW });
    assert.deepEqual(
      result.disabled,
      [],
      "a missing dir is an empty store, not a crash"
    );
    assert.equal(result.scanned, 0);
  });

  // concurrent boundary
  it("does not lose or half-write an entry saved concurrently with GC", async () => {
    await put("old", { ttl_days: 5, updated_at: daysAgo(10) });
    const save = createMemorySaveTool({
      memoryDir,
      now: () => new Date(NOW).toISOString(),
    });
    await Promise.all([
      runMemoryGc(memoryDir, { nowMs: NOW }),
      save.handler({ title: "Fresh fact", body: "Prefer baz() for new code." }),
    ]);
    const names = (await readdir(memoryDir)).filter(
      (n) => n.endsWith(".md") && n !== "MEMORY.md"
    );
    assert.equal(names.length, 2, "the concurrent save must survive GC");
    for (const name of names) {
      // Every landed file parses — tmp/rename means no partial content is
      // ever observable under a final slug path.
      parseMemoryEntry(await readFile(join(memoryDir, name), "utf8"));
    }
    assert.ok(
      (await readdir(memoryDir)).every((n) => !n.endsWith(".tmp")),
      "no tmp files left behind"
    );
  });

  it("keeps every file on disk — GC only soft-disables", async () => {
    await put("a", { ttl_days: 1, updated_at: daysAgo(9) });
    await put("b", { supersedes: ["a"] });
    await runMemoryGc(memoryDir, { nowMs: NOW });
    const names = (await readdir(memoryDir)).filter((n) => n.endsWith(".md"));
    assert.deepEqual(names.sort(), ["a.md", "b.md"]);
  });
});

// -- runMemoryGc: archive (specs/auto-memory-layering.md SC10/SC13/SC14/SC15) --

describe("runMemoryGc — archive disabled entries out of the hot dir", () => {
  // SC10
  it("archives a disabled entry whose updated_at is 31 days old", async () => {
    await put("stale", { disabled: true, updated_at: daysAgo(31) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived, ["stale"]);
    const hotNames = (await readdir(memoryDir)).filter((n) =>
      n.endsWith(".md")
    );
    assert.ok(
      !hotNames.includes("stale.md"),
      "the slug must have left the hot dir"
    );
    const archived = parseMemoryEntry(
      await readFile(join(memoryDir, "archive", "stale.md"), "utf8")
    );
    assert.equal(archived.disabled, true, "archived copy keeps content");
    const scan = await listStoreEntries(memoryDir);
    assert.ok(
      !scan.entries.some((c) => c.slug === "stale"),
      "listStoreEntries must not see archived entries"
    );
  });

  // SC10 boundary: "≥ 30 天" — exactly 30 days archives, 29 does not.
  it("archives at exactly 30 days but keeps a 29-day disabled entry hot", async () => {
    await put("edge30", { disabled: true, updated_at: daysAgo(30) });
    await put("edge29", { disabled: true, updated_at: daysAgo(29) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived.sort(), ["edge30"]);
    assert.ok(
      (await readdir(join(memoryDir, "archive"))).includes("edge30.md")
    );
    await get("edge29"); // still hot and parseable
  });

  // SC13: disabled-count overflow past the cap archives the excess oldest-first.
  it("archives excess disabled entries oldest-updated_at-first when disabled count exceeds the cap", async () => {
    await put("d1", { disabled: true, updated_at: daysAgo(29) });
    await put("d2", { disabled: true, updated_at: daysAgo(20) });
    await put("d3", { disabled: true, updated_at: daysAgo(10) });
    await put("d4", { disabled: true, updated_at: daysAgo(5) });
    await put("live", { updated_at: daysAgo(1) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW, cap: 2 });
    assert.deepEqual(result.archived.sort(), ["d1", "d2"]);
    const archived = (await readdir(join(memoryDir, "archive"))).sort();
    assert.deepEqual(archived, ["d1.md", "d2.md"]);
    const scan = await listStoreEntries(memoryDir);
    assert.deepEqual(
      scan.entries.map((c) => c.slug),
      ["d3", "d4", "live"],
      "the remaining disabled entries and live entries stay hot"
    );
    assert.equal((await get("d3")).disabled, true);
    assert.equal((await get("live")).disabled, false);
  });

  // SC13 boundary: exactly cap-many disabled entries → nothing archived.
  it("archives nothing when disabled count equals the cap", async () => {
    await put("d1", { disabled: true, updated_at: daysAgo(20) });
    await put("d2", { disabled: true, updated_at: daysAgo(10) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW, cap: 2 });
    assert.deepEqual(result.archived, []);
    assert.ok(
      !(await readdir(memoryDir).then((ns) => ns.includes("archive"))),
      "no archive/ dir is created when nothing moves"
    );
  });

  // Live entries are never archived, however old.
  it("never archives a live entry even when its updated_at is ancient", async () => {
    await put("ancient", { updated_at: daysAgo(300) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived, []);
    await get("ancient"); // still hot
  });

  // SC14: replay over the same memoryDir is idempotent, no half-files.
  it("is idempotent on a second archive pass — dir contents stable, no partial files", async () => {
    await put("stale", { disabled: true, updated_at: daysAgo(31) });
    await put("d1", { disabled: true, updated_at: daysAgo(29) });
    const first = await runMemoryGc(memoryDir, { nowMs: NOW, cap: 1 });
    assert.deepEqual(first.archived.sort(), ["d1", "stale"]);
    const hotBefore = (await readdir(memoryDir)).sort();
    const archiveBefore = (await readdir(join(memoryDir, "archive"))).sort();

    const second = await runMemoryGc(memoryDir, { nowMs: NOW, cap: 1 });
    assert.deepEqual(second.archived, []);
    assert.deepEqual(second.disabled, []);
    assert.deepEqual((await readdir(memoryDir)).sort(), hotBefore);
    assert.deepEqual(
      (await readdir(join(memoryDir, "archive"))).sort(),
      archiveBefore
    );
    assert.ok(
      [...hotBefore, ...archiveBefore].every((n) => !n.endsWith(".tmp")),
      "no tmp files left behind"
    );
  });

  // SC15: archive rename failure surfaces as the typed MemoryIOError
  // (host EXIT log-and-continue is pinned by auto-hook.test.ts around
  // auto-hook.ts:243-251, which wraps runMemoryGc in try/catch).
  it("throws a typed MemoryIOError when the archive path is not a directory", async () => {
    await put("stale", { disabled: true, updated_at: daysAgo(31) });
    await writeFile(join(memoryDir, "archive"), "not a dir", "utf8");
    await assert.rejects(
      runMemoryGc(memoryDir, { nowMs: NOW }),
      (e: unknown) =>
        e instanceof MemoryIOError && /archive/.test((e as Error).message)
    );
  });

  // MEMORY.md policy (spec: "对应行删除或忽略失效链" — this impl deletes the line).
  it("removes the archived slug's line from MEMORY.md and keeps other lines", async () => {
    await put("stale", { disabled: true, updated_at: daysAgo(31) });
    await put("keep", { updated_at: daysAgo(1) });
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      [
        "- [Old fact](stale.md) · importance=1 · updated_at=2026-07-26T00:00:00.000Z",
        "- [Keep me](keep.md) · importance=2 · updated_at=2026-08-25T00:00:00.000Z",
        "",
      ].join("\n"),
      "utf8"
    );
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived, ["stale"]);
    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.ok(!index.includes("stale.md"), "archived line must be removed");
    assert.ok(index.includes("(keep.md)"), "live line must survive");
  });

  it("leaves MEMORY.md alone when it does not exist", async () => {
    await put("stale", { disabled: true, updated_at: daysAgo(31) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived, ["stale"]);
    assert.ok(
      !(await readdir(memoryDir).then((ns) => ns.includes("MEMORY.md")))
    );
  });

  // Hot scans stay archive-free: a populated archive/ subdir never leaks
  // into listStoreEntries or GC planning.
  it("never scans the archive/ subdirectory", async () => {
    await mkdir(join(memoryDir, "archive"), { recursive: true });
    await writeFile(
      join(memoryDir, "archive", "buried.md"),
      serializeMemoryEntry(
        entry({ id: "buried", ttl_days: 1, updated_at: daysAgo(99) })
      ),
      "utf8"
    );
    await put("live", { updated_at: daysAgo(1) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.equal(result.scanned, 1, "archive/ contents are not scanned");
    assert.deepEqual(result.disabled, [], "buried.md is not re-disabled");
    assert.deepEqual(result.archived, []);
    const scan = await listStoreEntries(memoryDir);
    assert.deepEqual(
      scan.entries.map((c) => c.slug),
      ["live"],
      "listStoreEntries must not traverse archive/"
    );
  });
});

// -- capability sweep (specs/runtime-capability-memory-gate.md) --------------
//
// The sweep shares the GC pass: a live entry whose title/body trips
// `detectCapabilityObservation` is soft-disabled (`disabled: true`, never a
// hard delete) with the typed `capability_observation` reason. It runs in the
// same pass as TTL / supersede / cap — the fixture below pins one observable
// order: capability first, then the rest.

describe("planMemoryGc — capability sweep rule", () => {
  it("disables a runtime capability observation with the typed reason", () => {
    const plan = planMemoryGc(
      [{ slug: "cap", entry: entry({ ...CAPABILITY, disabled: false }) }],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, [
      { slug: "cap", reason: "capability_observation" },
    ]);
    assert.deepEqual(plan.keep, []);
  });

  it("leaves a product-policy constraint and a convention alone", () => {
    const plan = planMemoryGc(
      [
        { slug: "policy", entry: entry({ ...POLICY, disabled: false }) },
        {
          slug: "convention",
          entry: entry({
            type: "convention",
            title: "Test command",
            body: "Run npm test in the repo root.",
            disabled: false,
          }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, []);
    assert.deepEqual([...plan.keep].sort(), ["convention", "policy"]);
  });

  it("is idempotent — an already-disabled capability entry is not re-disabled", () => {
    const first = planMemoryGc(
      [{ slug: "cap", entry: entry({ ...CAPABILITY, disabled: false }) }],
      { nowMs: NOW }
    );
    const second = planMemoryGc(
      [{ slug: "cap", entry: entry({ ...CAPABILITY, disabled: true }) }],
      { nowMs: NOW }
    );
    assert.deepEqual(first.disable, [
      { slug: "cap", reason: "capability_observation" },
    ]);
    assert.deepEqual(second.disable, [], "no second disable");
  });

  // Overflow (spec SC3): the capability verdict must not be crowded out by the
  // cap rule — every category is disabled in the same pass, so an over-cap
  // store still sweeps its capability rows. Order pinned: capability rows
  // first, then TTL, supersede, cap.
  it("sweeps the capability row even when the store is over cap", () => {
    const plan = planMemoryGc(
      [
        { slug: "cap", entry: entry({ ...CAPABILITY, importance: 9 }) },
        { slug: "hot", entry: entry({ importance: 5 }) },
        { slug: "other", entry: entry({ importance: 1 }) },
      ],
      { nowMs: NOW, cap: 1 }
    );
    assert.deepEqual(plan.disable, [
      { slug: "cap", reason: "capability_observation" },
      { slug: "other", reason: "cap_evicted" },
    ]);
  });

  it("orders capability first when a TTL expiry lands in the same pass", () => {
    const plan = planMemoryGc(
      [
        { slug: "cap", entry: entry({ ...CAPABILITY }) },
        {
          slug: "stale",
          entry: entry({ ttl_days: 1, updated_at: daysAgo(9) }),
        },
      ],
      { nowMs: NOW }
    );
    assert.deepEqual(plan.disable, [
      { slug: "cap", reason: "capability_observation" },
      { slug: "stale", reason: "ttl_expired" },
    ]);
  });
});

describe("runMemoryGc — capability sweep", () => {
  it("soft-disables the capability entry on disk and keeps the policy constraint live", async () => {
    await put("cap", { ...CAPABILITY });
    await put("policy", { ...POLICY });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.disabled, [
      { slug: "cap", reason: "capability_observation" },
    ]);
    assert.equal((await get("cap")).disabled, true);
    assert.equal((await get("policy")).disabled, false);
    assert.equal(
      (await readdir(memoryDir)).includes("cap.md"),
      true,
      "sweep never hard-deletes the file"
    );
  });

  it("is idempotent on a second pass", async () => {
    await put("cap", { ...CAPABILITY });
    const first = await runMemoryGc(memoryDir, { nowMs: NOW });
    const second = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(first.disabled, [
      { slug: "cap", reason: "capability_observation" },
    ]);
    assert.deepEqual(second.disabled, [], "second pass has nothing to do");
    assert.deepEqual(second.archived, []);
    assert.equal((await get("cap")).disabled, true);
  });

  it("archives a capability entry exactly like any other disabled row", async () => {
    // Sweep + archive discipline share one path: an old capability row leaves
    // the hot dir (rename) and its MEMORY.md line is dropped, so the read-side
    // filter and the on-disk sweep agree.
    await put("cap", { ...CAPABILITY, updated_at: daysAgo(31) });
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      ["- [Old](cap.md) · importance=1", "- [Keep](keep.md)", ""].join("\n"),
      "utf8"
    );
    await put("keep", { updated_at: daysAgo(1) });
    const result = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(result.archived, ["cap"]);
    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.ok(!index.includes("cap.md"));
    assert.ok(index.includes("keep.md"));
    assert.deepEqual((await readdir(join(memoryDir, "archive"))).sort(), [
      "cap.md",
    ]);
  });

  // Concurrent (spec SC4): interleaving a legal memory_save with sweep/GC on
  // one memoryDir leaves no half files, and a second pass is a no-op.
  it("does not half-write when memory_save interleaves with the sweep", async () => {
    await put("cap", { ...CAPABILITY });
    const save = createMemorySaveTool({
      memoryDir,
      now: () => new Date(NOW).toISOString(),
    });
    const [saveResult] = await Promise.all([
      save.handler({ title: "Fresh fact", body: "Prefer baz() for new code." }),
      runMemoryGc(memoryDir, { nowMs: NOW }),
    ]);
    assert.ok(saveResult, "the concurrent save must land");
    const names = (await readdir(memoryDir)).filter(
      (n) => n.endsWith(".md") && n !== "MEMORY.md"
    );
    for (const name of names) {
      parseMemoryEntry(await readFile(join(memoryDir, name), "utf8"));
    }
    assert.ok(
      (await readdir(memoryDir)).every((n) => !n.endsWith(".tmp")),
      "no tmp files left behind"
    );
    const second = await runMemoryGc(memoryDir, { nowMs: NOW });
    assert.deepEqual(second.disabled, [], "second pass is idempotent");
  });

  // Exception (spec SC5): an unreadable store must surface the typed error,
  // not a partial disable set.
  it("throws a typed MemoryIOError when a sweep write target is not writable", async () => {
    await put("cap", { ...CAPABILITY });
    // A regular file where the archive dir must go: the archive rename path
    // fails with the typed error (same posture as the pre-existing archive
    // test) — the sweep's own write is exercised by the disable assertions.
    await writeFile(join(memoryDir, "archive"), "not a dir", "utf8");
    await put("old", { disabled: true, updated_at: daysAgo(31) });
    await assert.rejects(
      runMemoryGc(memoryDir, { nowMs: NOW }),
      (e: unknown) => e instanceof MemoryIOError
    );
  });
});
