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

  it("does not copy a single-line body into the catalog (SC2)", () => {
    const body = "The deploy pipeline runs only on Friday.";
    assert.equal(catalogHook(body), "");
    const out = formatMemoryCatalog([live("a", "Deploy Fridays", body)])!;
    assert.ok(out.includes("Deploy Fridays"));
    assert.ok(!out.includes(body));
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

describe("formatMemoryCatalog — capability filtering lives in the caller", () => {
  // The formatter stays a dumb renderer: it takes whatever live list the
  // caller passes, and the read-side filter (assembly / recall / prefetch)
  // is what drops capability observations. Pin the separation so a later
  // "just filter inside the formatter" edit cannot silently change recall /
  // prefetch behavior through this shared helper.
  it("renders whatever list it is handed, capability-shaped titles included", () => {
    const out = formatMemoryCatalog([
      live(
        "cap",
        "沙箱 DNS / SSRF / benchmarking 段导致 web_search 不可用",
        "本环境没有真实出网，不要调用 web 工具"
      ),
    ]);
    assert.ok(out !== undefined, "formatter renders the list it is given");
    assert.ok(out?.includes("沙箱 DNS / SSRF"));
  });
});
