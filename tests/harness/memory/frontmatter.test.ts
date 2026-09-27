/**
 * parseMemoryEntry / serializeMemoryEntry / computeSignature
 * pure-function tests.
 *
 * Coverage (frontmatter half): parse / round-trip / defaults for missing
 * fields / retention of excess fields / refusal of a non-scalar excess field /
 * signature stability / error when the frontmatter fence is missing.
 *
 * The read side parses through the shared frontmatter module (ADR-0123), so
 * these tests pin both the old flat-subset shapes (they must keep parsing
 * identically) and the coerce-boundary shapes (block scalars, block/flow
 * lists, nested mappings, YAML-invalid blocks). The write side emits its
 * frontmatter map through `yaml.stringify`, so its byte contract is the quoted
 * YAML form — pinned here by the exact fence-block assertions and by round-trip
 * totality over every shape the writer can emit.
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
// A degraded parse must never be silent: the warn seam is part of the contract
// these cases pin, so the shared recorder wraps every reading run.
import { captureConsoleWarn } from "../../_helpers/capture-console-warn.ts";

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

/** The frontmatter key lines between the `---` fences. */
function fenceLines(out: string): string[] {
  const lines = out.split("\n");
  assert.equal(lines[0], "---", "file must open with a fence");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 1, "file must close the fence");
  return lines.slice(1, close);
}

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

  it("rejects a closing fence with same-line junk", () => {
    // A closing fence is `---` plus a newline or end of text; anything else on
    // that line means no fence was found, which is the typed-throw path.
    assert.throws(
      () => parseMemoryEntry("---\nid: x\n---xyz\nbody"),
      MemorySchemaInvalid
    );
  });

  it("reads a blank value as the empty string for a known key", () => {
    const out = parseMemoryEntry(
      frontmatter(["id: x", "title:", "updated_at:"], "body")
    );
    assert.equal(out.title, "");
    assert.equal(out.updated_at, "");
    assert.equal(out.id, "x");
  });

  it("accepts the authoring shapes the per-line parser could not: block list and quoted scalar", () => {
    const out = parseMemoryEntry(
      [
        "---",
        "id: x",
        'title: "Use bar() not foo()"',
        "supersedes:",
        "  - aaaa1111bbbb",
        "  - cccc2222dddd",
        "---",
        "body",
      ].join("\n")
    );
    assert.equal(out.title, "Use bar() not foo()");
    assert.deepEqual(out.supersedes, ["aaaa1111bbbb", "cccc2222dddd"]);
  });

  it("never registers a nested mapping key as a top-level field, and warns", () => {
    let parsed: Record<string, unknown> = {};
    const { messages: warned } = captureConsoleWarn(() => {
      parsed = parseMemoryEntry(
        frontmatter(["id: x", "title:", "  importance: 9"], "body")
      ) as unknown as Record<string, unknown>;
    });
    assert.equal(
      parsed.importance,
      1,
      "the indented child key must not overwrite the default field"
    );
    assert.ok(
      warned.length > 0,
      "the skipped mapping must be reported, never silent"
    );
  });

  it("quarantines a YAML-invalid block instead of returning defaults", () => {
    // Returning defaults used to be the degradation shape here. It is not
    // lossless: `store.listStoreEntries` files a non-throwing parse under
    // `entries`, so a GC soft-disable would write those defaults back over the
    // unreadable original and drop every field the reader could not see. Throwing
    // routes the file to `skipped`, which no writer path touches.
    for (const lines of [
      ["id: x", "title: Fix the parser: today"],
      ["id: x", "supersedes: , ,"],
    ]) {
      const raw = frontmatter(lines, "the body");
      const warned: string[] = [];
      assert.throws(
        () => captureConsoleWarn(() => parseMemoryEntry(raw), warned),
        MemorySchemaInvalid,
        `${lines[1]}: an unreadable block must fail closed`
      );
      assert.ok(
        warned.some((m) => /frontmatter/.test(m)),
        "the rejected block must still be reported, never silent"
      );
    }
  });

  it("leaves a legacy unquoted-colon title readable-by-nobody but intact on disk", () => {
    // The shape the pre-ADR writer emitted: `title: Rule: …` is not a legal YAML
    // scalar, so the strict reader rejects the block. The byte-level promise of
    // the migration is that such a file is reported and preserved, never
    // silently rewritten from defaults.
    const legacy = frontmatter(
      ["id: ab12cd34ef56", "title: Rule: lockfile edits go through npm"],
      "the body"
    );
    assert.throws(() => parseMemoryEntry(legacy), MemorySchemaInvalid);
    const { messages: warned } = captureConsoleWarn(() => {
      assert.throws(() => parseMemoryEntry(legacy));
    });
    assert.ok(
      warned.length > 0,
      "the quarantine must be reported, not just refused"
    );
  });
});

// -- serialize + round-trip --------------------------------------------------

describe("serializeMemoryEntry", () => {
  it("round-trips a complete entry through serialize and parse", () => {
    const e = full();
    assert.deepEqual(parseMemoryEntry(serializeMemoryEntry(e)), e);
  });

  it('round-trips a title containing ": " with its id intact', () => {
    // A YAML plain scalar may not contain ": ", so an unquoted title like this
    // made the shared reader reject the whole block — id and title both came
    // back as "" while the writer kept emitting them bare.
    const e: MemoryEntryV1 = {
      ...full(),
      id: "ab12cd34ef56",
      title: "Rule: lockfile edits go through npm",
    };
    const serialized = serializeMemoryEntry(e);
    assert.ok(
      serialized.includes('title: "Rule: lockfile edits go through npm"'),
      `the ambiguous scalar must be quoted, got: ${serialized}`
    );
    assert.deepEqual(parseMemoryEntry(serialized), e);
  });

  it("round-trips every value shape the writer can emit", () => {
    const longNoBreak = "x".repeat(120);
    const longWithSpaces = "alpha beta gamma ".repeat(8) + "omega";
    const shapes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["colon in title", { title: "Rule: a b" }],
      ["hash in title", { title: "cost #1 note" }],
      ["leading indicator", { title: "[draft] shape" }],
      ["long value with spaces", { title: longWithSpaces }],
      ["long value with no break", { title: longNoBreak }],
      ["comma list supersedes", { supersedes: ["aaaa1111bbbb", "cccc2222"] }],
      ["unicode title", { title: "测试命令与目录习惯" }],
      ["blank id", { id: "" }],
      ["boolish string title", { title: "true" }],
      ["scalar extras", { promoted: true, source: "auto", rank: 2 }],
    ];
    for (const [label, overrides] of shapes) {
      const e = { ...full(), ...overrides } as MemoryEntryV1;
      const parsed = parseMemoryEntry(serializeMemoryEntry(e));
      assert.deepEqual(parsed, e, `${label}: entry must come back intact`);
      assert.equal(
        computeSignature(parsed),
        computeSignature(e),
        `${label}: signature must survive the round trip`
      );
    }
  });

  it("writes a long value on one line instead of folding it", () => {
    const title = "alpha beta gamma ".repeat(8) + "omega";
    const out = serializeMemoryEntry({ ...full(), title });
    assert.equal(
      out.split("\n").filter((line) => line.startsWith("title:")).length,
      1,
      "a folded value is the corruption class this writer exists to end"
    );
    assert.equal(parseMemoryEntry(out).title, title);
  });

  it("writes a blank id as a quoted empty scalar that re-parses to the empty string", () => {
    const out = serializeMemoryEntry({ ...full(), id: "" });
    assert.ok(
      out.includes('\nid: ""\n'),
      `blank values are pinned to the quoted form, got: ${out}`
    );
    assert.equal(parseMemoryEntry(out).id, "");
  });

  it("keeps KNOWN_FRONT_KEYS order, sorts extras, and leaves body out of the block", () => {
    const e = full() as MemoryEntryV1 & Record<string, unknown>;
    e["zeta"] = "z";
    e["alpha"] = "a";
    const out = serializeMemoryEntry(e);
    assert.deepEqual(fenceLines(out), [
      "id: mem-1",
      "type: preference",
      "importance: 3",
      "ttl_days: 30",
      "disabled: false",
      "supersedes: null",
      "title: Use bar() not foo()",
      "updated_at: 2026-01-01T00:00:00.000Z",
      "alpha: a",
      "zeta: z",
    ]);
    assert.ok(
      !fenceLines(out).some((line) => line.startsWith("body:")),
      "body is the text after the closing fence, never a frontmatter key"
    );
  });

  it("signatures a pre-existing flat-form file exactly like the quoted form", () => {
    // Disk-format change discipline: files written by the previous writer keep
    // parsing and keep their identity, so dedupe/supersede is not invalidated.
    const legacy = frontmatter(
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
      full().body
    );
    const stored = parseMemoryEntry(legacy);
    assert.deepEqual(stored, full());
    assert.equal(computeSignature(stored), computeSignature(full()));
    assert.deepEqual(parseMemoryEntry(serializeMemoryEntry(stored)), stored);
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
    for (const raw of ["supersedes:", "supersedes: null"]) {
      const parsed = parseMemoryEntry(
        frontmatter(["id: x", raw.trim()], "body")
      );
      assert.equal(
        parsed.supersedes,
        null,
        `${raw} must parse to null (empty lists never occur)`
      );
      assert.equal(
        parsed.id,
        "x",
        `${raw} must be coerced per key, not by dropping the block`
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

  it("emits the pinned bytes for an entry whose extras are all scalar", () => {
    const e = {
      ...full(),
      promoted: true,
      tags: "alpha,beta",
    } as unknown as MemoryEntryV1;
    assert.equal(
      serializeMemoryEntry(e),
      [
        "---",
        "id: mem-1",
        "type: preference",
        "importance: 3",
        "ttl_days: 30",
        "disabled: false",
        "supersedes: null",
        "title: Use bar() not foo()",
        "updated_at: 2026-01-01T00:00:00.000Z",
        "promoted: true",
        "tags: alpha,beta",
        "---",
        "Calling bar() is the supported path; foo() is thread-unsafe.",
      ].join("\n")
    );
  });

  it("refuses a non-scalar extra with a typed error naming the key, not the value", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["tags", ["alpha", "beta"]],
      ["origin", { recorded_by: "tester" }],
    ];
    for (const [key, value] of cases) {
      const e = { ...full(), [key]: value } as unknown as MemoryEntryV1;
      let caught: unknown;
      try {
        serializeMemoryEntry(e);
      } catch (error) {
        caught = error;
      }
      assert.ok(
        caught instanceof MemorySchemaInvalid,
        `${key}: a non-scalar extra must be refused with a typed error, got ${String(caught)}`
      );
      const err: MemorySchemaInvalid = caught;
      assert.equal(err.field, key);
      assert.ok(err.message.includes(key), "the message must name the key");
      const valueTokens = JSON.stringify(value)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2);
      assert.ok(
        valueTokens.length > 0,
        "the fixture must carry recognizable value text"
      );
      for (const token of valueTokens)
        assert.ok(
          !err.message.includes(token),
          `the message must carry the key only, got: ${err.message}`
        );
    }
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
