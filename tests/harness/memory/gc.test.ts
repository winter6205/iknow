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
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryError,
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
        { slug: "new", entry: entry({ title: "New fact", supersedes: "old" }) },
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
            supersedes: "old",
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
      [{ slug: "new", entry: entry({ supersedes: "does-not-exist" }) }],
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
    await put("b", { supersedes: "a" });
    await runMemoryGc(memoryDir, { nowMs: NOW });
    const names = (await readdir(memoryDir)).filter((n) => n.endsWith(".md"));
    assert.deepEqual(names.sort(), ["a.md", "b.md"]);
  });
});
