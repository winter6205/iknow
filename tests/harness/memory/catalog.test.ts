/**
 * memory_catalog formatter: 200-line / 25KB caps (SC3).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MEMORY_CATALOG_DISCIPLINE,
  MEMORY_CATALOG_MAX_CHARS,
  MEMORY_CATALOG_MAX_LINES,
  catalogHook,
  formatMemoryCatalog,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

const live = (id: string, title: string, body: string): MemoryEntryV1 => ({
  id,
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title,
  body,
  updated_at: "2026-01-01T00:00:00.000Z",
});

describe("formatMemoryCatalog", () => {
  it("returns undefined for an empty live set", () => {
    assert.equal(formatMemoryCatalog([]), undefined);
  });

  it("starts with the locked English discipline sentence", () => {
    const out = formatMemoryCatalog([live("a", "Title A", "hook A\nBODY")]);
    assert.ok(out?.startsWith(MEMORY_CATALOG_DISCIPLINE));
    assert.ok(out?.includes("Title A"));
    assert.ok(!out?.includes("BODY"));
  });

  it("keeps only the first body line as the hook", () => {
    assert.equal(catalogHook("alpha hook\nrest of body"), "alpha hook");
  });

  it("caps directory lines at 200 (first-hit truncation)", () => {
    const many = Array.from({ length: MEMORY_CATALOG_MAX_LINES + 20 }, (_, i) =>
      live(`id-${i}`, `Title ${i}`, `hook ${i}`)
    );
    const out = formatMemoryCatalog(many)!;
    const dirLines = out.split("\n").slice(1);
    assert.equal(dirLines.length, MEMORY_CATALOG_MAX_LINES);
    assert.ok(out.includes("Title 0"));
    assert.ok(!out.includes(`Title ${MEMORY_CATALOG_MAX_LINES}`));
  });

  it("caps the catalog block at 25KB", () => {
    const huge = live("h", "H".repeat(MEMORY_CATALOG_MAX_CHARS), "hook");
    const out = formatMemoryCatalog([huge])!;
    assert.ok(out.length <= MEMORY_CATALOG_MAX_CHARS);
    assert.ok(out.startsWith(MEMORY_CATALOG_DISCIPLINE));
  });
});
