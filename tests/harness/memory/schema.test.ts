/**
 * sanitizeMemoryFile pure-function tests.
 *
 * Coverage (schema half): v1 sanitize / v0 backfill / reject schemaVersion > 1 /
 * unknown fields preserved / non-object root rejected; sanitize must stay a
 * pure function with no disk-write side effects.
 *
 * Failure path: throws typed MemorySchemaInvalid (not a bare Error, not a
 * structured-object literal — memory uses class-based typed errors per
 * src/harness/errors.ts precedent; the class carries the failing field).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MemorySchemaInvalid,
  normalizeMemoryType,
  sanitizeMemoryFile,
} from "../../../src/harness/memory/index.ts";

// -- fixtures ----------------------------------------------------------------

const entry = (overrides?: Readonly<Record<string, unknown>>) => ({
  id: "mem-1",
  type: "preference",
  importance: 3,
  ttl_days: 30,
  disabled: false,
  supersedes: null,
  title: "Use bar()",
  body: "Calling bar() is the supported path.",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** v0 file: no schemaVersion key at all. */
const v0File = () => ({ entries: [entry()] });

const v1File = (opts?: { entries?: unknown; schemaVersion?: unknown }) => ({
  schemaVersion: opts?.schemaVersion ?? 1,
  entries: opts?.entries ?? [entry()],
});

/** Assert the thrown error is a MemorySchemaInvalid with the given field. */
const isSchemaInvalid = (field: string) => (e: unknown) => {
  assert.ok(e instanceof MemorySchemaInvalid, `must be MemorySchemaInvalid`);
  assert.equal(e.field, field);
  return true;
};

// -- v1 pass-through ---------------------------------------------------------

describe("sanitizeMemoryFile — v1 pass-through", () => {
  it("passes a complete v1 file through with every field equal", () => {
    const input = v1File();
    const out = sanitizeMemoryFile(input);
    assert.equal(out.schemaVersion, 1);
    assert.deepEqual(out.entries, [entry()]);
  });

  it("keeps a string-array supersedes verbatim", () => {
    const out = sanitizeMemoryFile(
      v1File({ entries: [entry({ supersedes: ["aaaa1111bbbb"] })] })
    );
    assert.deepEqual(out.entries[0].supersedes, ["aaaa1111bbbb"]);
  });

  it("normalizes a supersedes list to null when empty, non-array, or all-invalid", () => {
    for (const bad of [[], [7, null, {}], "old", 42]) {
      const out = sanitizeMemoryFile(
        v1File({ entries: [entry({ supersedes: bad })] })
      );
      assert.equal(
        out.entries[0].supersedes,
        null,
        `${JSON.stringify(bad)} must normalize to null`
      );
    }
  });

  it("keeps the string elements of a mixed supersedes list", () => {
    const out = sanitizeMemoryFile(
      v1File({ entries: [entry({ supersedes: ["old", 7, null] })] })
    );
    assert.deepEqual(out.entries[0].supersedes, ["old"]);
  });

  it("returns an empty entries array for a v1 file with no entries", () => {
    const out = sanitizeMemoryFile(v1File({ entries: [] }));
    assert.deepEqual(out.entries, []);
  });
});

// -- v0 backfill -------------------------------------------------------------

describe("sanitizeMemoryFile — v0 file (no schemaVersion) backfill", () => {
  it("treats a missing schemaVersion as v1 and backfills it", () => {
    const out = sanitizeMemoryFile(v0File());
    assert.equal(out.schemaVersion, CURRENT_MEMORY_SCHEMA_VERSION);
    assert.equal(out.entries.length, 1);
  });

  it("preserves v0 entry fields unchanged during backfill", () => {
    const out = sanitizeMemoryFile({
      entries: [entry({ title: "original title" })],
    });
    assert.equal(out.entries[0].title, "original title");
  });
});

// -- reject-first ordering ---------------------------------------------------

describe("sanitizeMemoryFile — reject-first ordering", () => {
  it("rejects schemaVersion > CURRENT immediately, before any field handling", () => {
    // A future-version file with unknown fields + bad entries: the version
    // check must win — never enters the field-preservation branch.
    assert.throws(
      () =>
        sanitizeMemoryFile(
          v1File({
            schemaVersion: 2,
            entries: [{ id: "broken-missing-fields" }],
          })
        ),
      isSchemaInvalid("schemaVersion")
    );
  });
});

// -- structural rejection ----------------------------------------------------

describe("sanitizeMemoryFile — structural rejection", () => {
  it("rejects a non-object root", () => {
    for (const bad of [null, "a string", 42, undefined]) {
      assert.throws(
        () => sanitizeMemoryFile(bad as unknown),
        isSchemaInvalid("root"),
        `must reject ${JSON.stringify(bad)} as root`
      );
    }
  });

  it("rejects an array root", () => {
    assert.throws(
      () => sanitizeMemoryFile([] as unknown),
      isSchemaInvalid("root")
    );
  });

  it("rejects entries that is not an array", () => {
    assert.throws(
      () => sanitizeMemoryFile(v1File({ entries: "not-an-array" })),
      isSchemaInvalid("entries")
    );
  });
});

// -- entry field defaults ----------------------------------------------------

describe("sanitizeMemoryFile — entry field defaults", () => {
  it("fills missing entry fields with spec defaults", () => {
    const out = sanitizeMemoryFile({
      schemaVersion: 1,
      entries: [{ id: "mem-min" }],
    });
    assert.equal(out.entries[0].type, "note");
    assert.equal(out.entries[0].importance, 1);
    assert.equal(out.entries[0].ttl_days, 0);
    assert.equal(out.entries[0].disabled, false);
    assert.equal(out.entries[0].supersedes, null);
    assert.equal(out.entries[0].title, "");
    assert.equal(out.entries[0].body, "");
    assert.equal(typeof out.entries[0].updated_at, "string");
  });

  it("rejects an entry that is not an object", () => {
    for (const bad of ["str", 42]) {
      assert.throws(
        () => sanitizeMemoryFile(v1File({ entries: [bad] })),
        isSchemaInvalid("entries"),
        `entry ${JSON.stringify(bad)} must be rejected`
      );
    }
  });
});

// -- unknown-field preservation ---------------------------------------------

describe("sanitizeMemoryFile — unknown fields preserved", () => {
  it("keeps unknown top-level fields on a v1 file", () => {
    const out = sanitizeMemoryFile({
      ...v1File(),
      future_flag: true,
    }) as unknown as Record<string, unknown>;
    assert.equal(out["future_flag"], true);
  });

  it("keeps unknown fields on an entry", () => {
    const out = sanitizeMemoryFile(
      v1File({ entries: [entry({ extra: { nested: 1 } })] })
    );
    assert.deepEqual(
      (out.entries[0] as unknown as Record<string, unknown>)["extra"],
      { nested: 1 }
    );
  });
});

// -- closed memory_type enum (#731) ------------------------------------------

describe("normalizeMemoryType", () => {
  it("declares exactly the five legal values", () => {
    assert.deepEqual(
      [...MEMORY_TYPES],
      ["convention", "decision", "gotcha", "constraint", "note"]
    );
  });

  it("returns a legal value verbatim", () => {
    for (const legal of MEMORY_TYPES) {
      assert.equal(normalizeMemoryType(legal), legal);
    }
  });

  it("falls back to note for an illegal, empty, or absent value", () => {
    for (const bad of ["nope", "", undefined, null, 7, {}, ["note"]]) {
      assert.equal(
        normalizeMemoryType(bad),
        "note",
        `${JSON.stringify(bad)} must normalize to note`
      );
    }
  });

  it("matches exactly — no trimming and no case folding", () => {
    for (const near of [" note", "note ", "Note", "DECISION", "Convention"]) {
      assert.equal(normalizeMemoryType(near), "note");
    }
  });

  it("leaves the stored frontmatter type untouched (write-path-only scope)", () => {
    // sanitizeMemoryFile is the read path: a legacy `preference` entry keeps
    // its recorded type so old files round-trip verbatim.
    const out = sanitizeMemoryFile(v1File({ entries: [entry()] }));
    assert.equal(out.entries[0].type, "preference");
  });
});
