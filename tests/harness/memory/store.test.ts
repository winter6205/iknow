/**
 * Store reader tests (store.ts listStoreEntries).
 *
 * Spec: specs/memory-frontmatter-write-signals.md SC-B1 — a file the reader
 * cannot parse is quarantined into a structured `skipped` record (slug +
 * machine-usable reason category, never file content) and its bytes stay
 * untouched; skipped order is deterministic, not directory order.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemorySchemaInvalid,
  listStoreEntries,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type {
  MemoryEntryV1,
  MemorySkipReason,
} from "../../../src/harness/memory/index.ts";
// `classifySkip` is deliberately NOT re-exported from index.ts: it is imported
// from its own module so the reason grammar can be exercised at the unit level
// instead of by mocking the filesystem to force a fault.
import { classifySkip } from "../../../src/harness/memory/store.ts";

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "memory-store-"));
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
  updated_at: "2026-02-01T00:00:00.000Z",
  ...overrides,
});

/** Fenced but not parseable YAML — the reader rejects the whole block. */
const yamlInvalid = (secret: string): string =>
  [
    "---",
    "id: ab12cd34ef56",
    "title: Rule: lockfile edits go through npm",
    "---",
    secret,
    "",
  ].join("\n");

describe("listStoreEntries — structured skipped", () => {
  it("quarantines the YAML-invalid file as {slug, reason} and preserves its bytes", async () => {
    const secret = "SECRET-BODY-MUST-NEVER-LEAK-INTO-A-RECORD";
    await writeFile(join(memoryDir, "broken.md"), yamlInvalid(secret), "utf8");
    await writeFile(
      join(memoryDir, "healthy.md"),
      serializeMemoryEntry(entry({ id: "healthy" })),
      "utf8"
    );
    const bytesBefore = await readFile(join(memoryDir, "broken.md"), "utf8");

    const scan = await listStoreEntries(memoryDir);

    assert.deepEqual(
      scan.entries.map((e) => e.slug),
      ["healthy"]
    );
    // deepEqual on the full record pins slug + reason and nothing else: no
    // title, no body, no raw text can ride along in the record.
    assert.deepEqual(scan.skipped, [
      { slug: "broken", reason: "frontmatter_unreadable" },
    ]);
    assert.ok(!JSON.stringify(scan.skipped).includes(secret));
    assert.equal(
      await readFile(join(memoryDir, "broken.md"), "utf8"),
      bytesBefore,
      "a scan must leave the quarantined file byte-identical"
    );
  });

  it("sorts skipped records by slug so scan order never leaks into a verdict", async () => {
    await writeFile(join(memoryDir, "zeta.md"), yamlInvalid("z body"), "utf8");
    await writeFile(join(memoryDir, "alpha.md"), yamlInvalid("a body"), "utf8");

    const scan = await listStoreEntries(memoryDir);

    assert.deepEqual(scan.skipped, [
      { slug: "alpha", reason: "frontmatter_unreadable" },
      { slug: "zeta", reason: "frontmatter_unreadable" },
    ]);
  });

  it("a missing directory reads as an empty store with no skipped records", async () => {
    const scan = await listStoreEntries(join(memoryDir, "absent"));
    assert.deepEqual(scan.entries, []);
    assert.deepEqual(scan.skipped, []);
  });
});

// SC-B1's record shape is only a contract while the reason stays inside a
// bounded grammar: a category is a wire-stable token, never an exception
// message (which could carry the file's own text) and never a crash.
describe("classifySkip — bounded reason grammar", () => {
  it("files the typed quarantine throw under its own category", () => {
    assert.equal(
      classifySkip(new MemorySchemaInvalid("frontmatter")),
      "frontmatter_unreadable"
    );
  });

  it("carries the errno code when the read fault has one", () => {
    const errno = Object.assign(new Error("read failed"), { code: "EIO" });
    assert.equal(classifySkip(errno), "read_failed:EIO");
  });

  it("degrades a codeless fault to the bare category", () => {
    assert.equal(classifySkip(new Error("disk went away")), "read_failed");
  });

  it("stays total over a nullish or non-object throw", () => {
    // A throw is `unknown` at this seam: reading `.code` off null or
    // undefined used to replace the skip record with a TypeError, which would
    // stall the whole maintenance pass — the exact failure the skip record
    // exists to prevent.
    for (const thrown of [null, undefined, "", 0, false, "boom"]) {
      assert.equal(
        classifySkip(thrown),
        "read_failed",
        `${JSON.stringify(String(thrown))} must classify, not crash`
      );
    }
  });

  it("every category is a member of the exported union", () => {
    // Compile-time tie: the union is the only thing a caller may switch on.
    const reasons: MemorySkipReason[] = [
      classifySkip(new MemorySchemaInvalid("frontmatter")),
      classifySkip({ code: "ENOENT" }),
      classifySkip(null),
    ];
    assert.deepEqual(reasons, [
      "frontmatter_unreadable",
      "read_failed:ENOENT",
      "read_failed",
    ]);
  });
});
