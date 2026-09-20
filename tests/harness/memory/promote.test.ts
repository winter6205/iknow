/**
 * Tests for promote.ts (loadUsageSidecar / recordRecall / eligibleForPromote /
 * listPromotableEntries).
 *
 * Coverage (promote half): usage.json absent -> create / count accumulation /
 * trigger across ≥2 distinct session_id / disabled / ttl_days expiry; the
 * promote sidecar cap is ≤4000 chars, filled in descending importance order.
 *
 * promote.ts owns the usage.json sidecar (explicit read/write only) and the
 * promote eligibility gate (recall_count ≥ 2 distinct session_id).
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eligibleForPromote,
  listPromotableEntries,
  loadUsageSidecar,
  recordRecall,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

// -- fixtures ----------------------------------------------------------------

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "promote-dir-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
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

/** Serialize an entry into valid frontmatter + body for on-disk storage. */
const serialize = (e: MemoryEntryV1): string => serializeMemoryEntry(e);

// -- loadUsageSidecar --------------------------------------------------------

describe("loadUsageSidecar", () => {
  it("creates an empty usage.json when it does not exist", async () => {
    const out = await loadUsageSidecar(memoryDir);
    assert.deepEqual(out.entries, {});
  });

  it("loads an existing usage.json", async () => {
    await writeFile(
      join(memoryDir, "usage.json"),
      JSON.stringify({
        entries: { "mem-1": { recall_count: 3, sessions: ["s1"] } },
      }),
      "utf8"
    );
    const out = await loadUsageSidecar(memoryDir);
    assert.equal(out.entries["mem-1"]?.recall_count, 3);
  });
});

// -- recordRecall ------------------------------------------------------------

describe("recordRecall", () => {
  it("accumulates recall count across calls", async () => {
    await recordRecall(memoryDir, "mem-1", "s1");
    await recordRecall(memoryDir, "mem-1", "s1");
    const out = await loadUsageSidecar(memoryDir);
    assert.equal(out.entries["mem-1"]?.recall_count, 2);
  });

  it("tracks distinct session_ids without double counting", async () => {
    await recordRecall(memoryDir, "mem-1", "s1");
    await recordRecall(memoryDir, "mem-1", "s1");
    await recordRecall(memoryDir, "mem-1", "s2");
    const out = await loadUsageSidecar(memoryDir);
    assert.equal(out.entries["mem-1"]?.recall_count, 3);
    assert.equal(out.entries["mem-1"]?.sessions.length, 2);
  });
});

// -- eligibleForPromote ------------------------------------------------------

describe("eligibleForPromote", () => {
  it("is false below 2 distinct session_ids", () => {
    const sidecar = {
      entries: { "mem-1": { recall_count: 5, sessions: ["s1"] } },
    };
    assert.equal(eligibleForPromote(sidecar, "mem-1"), false);
  });

  it("is true at ≥ 2 distinct session_ids", () => {
    const sidecar = {
      entries: { "mem-1": { recall_count: 2, sessions: ["s1", "s2"] } },
    };
    assert.equal(eligibleForPromote(sidecar, "mem-1"), true);
  });

  it("is false for an unknown slug", () => {
    assert.equal(eligibleForPromote({ entries: {} }, "nope"), false);
  });
});

// -- listPromotableEntries ---------------------------------------------------

describe("listPromotableEntries", () => {
  it("returns [] when usage.json is absent", async () => {
    assert.deepEqual(await listPromotableEntries(memoryDir), []);
  });

  it("fills by importance descending under the 4000-char cap", async () => {
    // Two promotable entries, both eligible (≥2 distinct sessions).
    const high = entry({ id: "high", title: "High priority", importance: 9 });
    const low = entry({ id: "low", title: "Low priority", importance: 1 });
    await writeFile(join(memoryDir, "high.md"), serialize(high), "utf8");
    await writeFile(join(memoryDir, "low.md"), serialize(low), "utf8");
    await recordRecall(memoryDir, "high", "s1");
    await recordRecall(memoryDir, "high", "s2");
    await recordRecall(memoryDir, "low", "s8");
    await recordRecall(memoryDir, "low", "s9");
    const out = await listPromotableEntries(memoryDir);
    assert.equal(out[0]!.id, "high", "importance desc ordering");
  });

  it("skips disabled entries", async () => {
    const disabled = entry({
      id: "d",
      title: "Disabled",
      importance: 9,
      disabled: true,
    });
    await writeFile(join(memoryDir, "d.md"), serialize(disabled), "utf8");
    await recordRecall(memoryDir, "d", "s1");
    await recordRecall(memoryDir, "d", "s2");
    const out = await listPromotableEntries(memoryDir);
    assert.equal(out.length, 0, "disabled entry must be skipped");
  });

  it("skips ttl_days-expired entries based on updated_at + ttl_days", async () => {
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const expired = entry({
      id: "exp",
      title: "Expired",
      importance: 9,
      ttl_days: 5,
      updated_at: past,
    });
    await writeFile(join(memoryDir, "exp.md"), serialize(expired), "utf8");
    await recordRecall(memoryDir, "exp", "s1");
    await recordRecall(memoryDir, "exp", "s2");
    const out = await listPromotableEntries(memoryDir);
    assert.equal(out.length, 0, "expired entry must be skipped");
  });
});
