/**
 * parseMemoryEntry / serializeMemoryEntry / computeSignature
 * pure-function tests.
 *
 * Coverage (frontmatter half): parse / round-trip / defaults for missing
 * fields / retention of excess fields / signature stability / error when the
 * frontmatter fence is missing.
 *
 * Why no YAML dependency: spec Tech Stack bans new npm deps. The frontmatter
 * format here is a minimal scalar subset (key: value lines); the parse path
 * needs only string / number / boolean / null coercion for known fields and
 * naive preservation for unknown scalar keys.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MemorySchemaInvalid,
  computeSignature,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

// -- fixtures ----------------------------------------------------------------

const full = (): MemoryEntryV1 => ({
  id: "mem-1",
  type: "preference",
  importance: 3,
  ttl_days: 30,
  disabled: false,
  supersedes: null,
  title: "Use bar() not foo()",
  body: "Calling bar() is the supported path; foo() is thread-unsafe.",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const frontmatter = (lines: ReadonlyArray<string>, body = "") =>
  ["---", ...lines, "---", body].join("\n");

// -- parse -------------------------------------------------------------------

describe("parseMemoryEntry", () => {
  it("parses the 6 core fields plus title and updated_at from frontmatter", () => {
    const raw = frontmatter(
      [
        "id: mem-1",
        "type: preference",
        "importance: 3",
        "ttl_days: 30",
        "disabled: false",
        "supersedes: null",
        "title: Use bar() not foo()",
        "updated_at: 2026-01-01T00:00:00.000Z",
      ],
      "Calling bar() is the supported path; foo() is thread-unsafe."
    );
    assert.deepEqual(parseMemoryEntry(raw), full());
  });

  it("reads the body from the text after the closing ---", () => {
    const out = parseMemoryEntry(
      frontmatter(["id: x", "title: y"], "body text only")
    );
    assert.equal(out.body, "body text only");
  });

  it("treats an absent body as the empty string", () => {
    const out = parseMemoryEntry(frontmatter(["id: x", "title: y"]));
    assert.equal(out.body, "");
  });

  it("fills missing fields with defaults", () => {
    const out = parseMemoryEntry(frontmatter(["id: only-id"], "the body"));
    assert.equal(out.type, "note");
    assert.equal(out.importance, 1);
    assert.equal(out.disabled, false);
    assert.equal(out.body, "the body");
  });

  it("coerces known scalar fields by their declared type", () => {
    const out = parseMemoryEntry(
      frontmatter(["id: x", "importance: 5", "ttl_days: 7", "disabled: true"])
    );
    assert.equal(out.importance, 5);
    assert.equal(out.ttl_days, 7);
    assert.equal(out.disabled, true);
  });

  it("preserves unknown frontmatter fields on the parsed entry", () => {
    const raw = frontmatter(
      [
        "id: x",
        "type: note",
        "importance: 1",
        "ttl_days: 0",
        "disabled: false",
        "supersedes: null",
        "title: t",
        "updated_at: 2026-01-01T00:00:00.000Z",
        "promoted: true",
      ],
      "body"
    );
    const parsed = parseMemoryEntry(raw) as unknown as Record<string, unknown>;
    assert.equal(parsed["promoted"], true);
  });

  it("throws MemorySchemaInvalid when the --- wrapper is missing", () => {
    assert.throws(() => parseMemoryEntry("plain text"), MemorySchemaInvalid);
    assert.throws(
      () => parseMemoryEntry("--- id: x"), // no closing ---
      MemorySchemaInvalid
    );
  });
});

// -- serialize + round-trip --------------------------------------------------

describe("serializeMemoryEntry", () => {
  it("round-trips a complete entry through serialize and parse", () => {
    const e = full();
    assert.deepEqual(parseMemoryEntry(serializeMemoryEntry(e)), e);
  });

  it("round-trips a supersedes id list as a flat comma-joined value", () => {
    const e = { ...full(), supersedes: ["aaaa1111bbbb", "cccc2222dddd"] };
    const serialized = serializeMemoryEntry(e);
    assert.ok(
      serialized.includes("\nsupersedes: aaaa1111bbbb,cccc2222dddd\n"),
      "the flat list form must keep the supersedes key name"
    );
    assert.deepEqual(parseMemoryEntry(serialized).supersedes, [
      "aaaa1111bbbb",
      "cccc2222dddd",
    ]);
  });

  it("normalizes an empty or blank supersedes list back to null on parse", () => {
    for (const raw of ["supersedes:", "supersedes: null", "supersedes: , ,"]) {
      const parsed = parseMemoryEntry(
        frontmatter(["id: x", raw.trim()], "body")
      );
      assert.equal(
        parsed.supersedes,
        null,
        `${raw} must parse to null (empty lists never occur)`
      );
    }
  });

  it("writes the 6 core fields plus title and updated_at before ---", () => {
    const out = serializeMemoryEntry(full());
    assert.match(out, /^---\n/);
    assert.match(out, /^---\nid: mem-1/m);
    assert.ok(out.includes("\nimportance: 3\n"));
    assert.ok(out.includes("\nttl_days: 30\n"));
    assert.ok(out.includes("\ndisabled: false\n"));
    assert.ok(out.includes("\nsupersedes: null\n"));
    assert.ok(out.includes("\ntitle: Use bar() not foo()\n"));
    assert.ok(out.includes("\nupdated_at: 2026-01-01T00:00:00.000Z\n"));
  });

  it("writes the body after the closing ---", () => {
    const out = serializeMemoryEntry(full());
    const idx = out.indexOf("\n---\n");
    assert.notEqual(idx, -1);
    assert.equal(
      out.slice(idx + 5),
      "Calling bar() is the supported path; foo() is thread-unsafe."
    );
  });

  it("preserves unknown frontmatter fields through round-trip", () => {
    const e = full() as MemoryEntryV1 & Record<string, unknown>;
    e["promoted"] = true;
    e["tags"] = "alpha,beta";
    const reser = serializeMemoryEntry(e);
    assert.ok(reser.includes("promoted: true"));
    assert.ok(reser.includes("tags: alpha,beta"));
    const parsed = parseMemoryEntry(reser) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(parsed["promoted"], true);
    assert.equal(parsed["tags"], "alpha,beta");
  });
});

// -- signature ---------------------------------------------------------------

describe("computeSignature", () => {
  it("is deterministic for the same entry", () => {
    const e = full();
    assert.equal(computeSignature(e), computeSignature(e));
    assert.equal(computeSignature(e), computeSignature({ ...e }));
  });

  it("changes when any of the 6 core fields change", () => {
    const base = full();
    assert.notEqual(
      computeSignature(base),
      computeSignature({ ...base, id: "other" })
    );
    assert.notEqual(
      computeSignature(base),
      computeSignature({ ...base, body: base.body + " more" })
    );
  });

  it("ignores unknown extra fields (signature covers canonical fields only)", () => {
    const base = full();
    const withExtra = {
      ...base,
      promoted: true,
    } as MemoryEntryV1;
    assert.equal(computeSignature(base), computeSignature(withExtra));
  });
});
