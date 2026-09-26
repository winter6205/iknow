/**
 * parseFrontmatter — the frontmatter coercion boundary in docs/CONTEXT.md:
 * scalars flatten to strings, scalar arrays fold
 * on `", "`, mappings are skipped with a warning and their child keys are never
 * registered as top-level keys (the #1128 silent-overwrite corruption path), a
 * broken block yields an empty map plus a warning and is flagged `rejected` so
 * a write-back consumer can fail closed, and nothing throws upward.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../../src/harness/frontmatter/index.ts";

describe("frontmatter parseFrontmatter", () => {
  it("reads flat key/value pairs as strings", () => {
    const result = parseFrontmatter("name: demo\ndescription: hello");
    assert.deepEqual(result.fields, { name: "demo", description: "hello" });
    assert.deepEqual(result.warnings, []);
  });

  it("keeps every field of a SKILL.md block that mixes all three shapes", () => {
    const result = parseFrontmatter(
      [
        "name: demo",
        "description: |-",
        "  first line",
        "  second line",
        "when_to_use: >-",
        "  folded",
        "  prose",
        "tags:",
        "  - a",
        "  - b",
        "allowed_tools: [read, write]",
      ].join("\n")
    );
    assert.deepEqual(result.fields, {
      name: "demo",
      description: "first line\nsecond line",
      when_to_use: "folded prose",
      tags: "a, b",
      allowed_tools: "read, write",
    });
    assert.deepEqual(result.warnings, []);
  });

  it("folds a literal block scalar (|-) to its text content", () => {
    const result = parseFrontmatter(
      "description: |-\n  line one\n  line two\n"
    );
    assert.deepEqual(result.fields, { description: "line one\nline two" });
    assert.deepEqual(result.warnings, []);
  });

  it("folds a folded block scalar (>-) to a single line", () => {
    const result = parseFrontmatter(
      "description: >-\n  line one\n  line two\n"
    );
    assert.deepEqual(result.fields, { description: "line one line two" });
    assert.deepEqual(result.warnings, []);
  });

  it("folds a block sequence to a comma-separated string", () => {
    assert.deepEqual(parseFrontmatter("tags:\n  - a\n  - b").fields, {
      tags: "a, b",
    });
  });

  it("folds a flow sequence to the same comma-separated string", () => {
    assert.deepEqual(parseFrontmatter("tags: [a, b]").fields, { tags: "a, b" });
    assert.deepEqual(parseFrontmatter('tags: ["a", "b"]').fields, {
      tags: "a, b",
    });
  });

  it("skips a nested mapping, warns, and never registers its child keys top-level", () => {
    const result = parseFrontmatter(
      [
        "name: real-name",
        "description: real-description",
        "metadata:",
        "  name: evil-name",
        "  description: evil-description",
      ].join("\n")
    );
    assert.deepEqual(result.fields, {
      name: "real-name",
      description: "real-description",
    });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /metadata/);
    assert.equal(Object.keys(result.fields).length, 2);
  });

  it("skips a flow-style nested mapping the same way", () => {
    const result = parseFrontmatter("name: real-name\nmetadata: {name: evil}");
    assert.deepEqual(result.fields, { name: "real-name" });
    assert.equal(result.warnings.length, 1);
  });

  it("skips a sequence whose items are mappings, with a warning", () => {
    const result = parseFrontmatter("steps:\n  - name: a\n  - name: b");
    assert.deepEqual(result.fields, {});
    assert.equal(result.warnings.length, 1);
  });

  it("skips an entry whose key is not a scalar, with a warning", () => {
    const result = parseFrontmatter("? [a, b]\n: v\nname: demo");
    assert.deepEqual(result.fields, { name: "demo" });
    assert.equal(result.warnings.length, 1);
  });

  it("skips an alias value — including a merge key — instead of guessing at it", () => {
    const alias = parseFrontmatter("base: &b one\nname: *b");
    assert.deepEqual(alias.fields, { base: "one" });
    assert.equal(alias.warnings.length, 1);

    const merge = parseFrontmatter("defaults: &d\n  x: 1\n<<: *d");
    assert.deepEqual(merge.fields, {});
    assert.equal(merge.warnings.length, 2);
  });

  it("drops the whole block and warns once on a syntax failure", () => {
    const result = parseFrontmatter("name: demo\ntags: [unclosed\n");
    assert.deepEqual(result.fields, {});
    assert.equal(result.warnings.length, 1);
  });

  it('marks a block-level failure "rejected" but keeps per-key skips accepted', () => {
    // `rejected` is the fact a write-back consumer needs: `fields` is `{}` both
    // for a block that could not be read at all and for a key-less block, and
    // only the first means there is on-disk data that would be lost by
    // replacing it with defaults.
    assert.equal(
      parseFrontmatter("title: a value: with: two colons").rejected,
      true,
      "a scalar the grammar cannot read rejects the whole block"
    );
    assert.equal(parseFrontmatter("- just\n- a\n- sequence").rejected, true);
    assert.equal(
      parseFrontmatter("name: real\nmetadata:\n  child: x").rejected,
      false,
      "one skipped key is not a block rejection: what was read stays readable"
    );
    assert.equal(parseFrontmatter("").rejected, false);
    assert.equal(parseFrontmatter("# only a comment").rejected, false);
  });

  it("reports a multi-line parser error as one warning line", () => {
    // Every consumer forwards warnings into a line-based channel; an embedded
    // newline would split one degradation into several unrelated rows.
    const warning = parseFrontmatter("name: demo\ntags: [unclosed\n")
      .warnings[0];
    assert.ok(!warning.includes("\n"), `got: ${JSON.stringify(warning)}`);
  });

  it("returns an empty map without warning for an empty block", () => {
    const result = parseFrontmatter("");
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.warnings, []);
  });

  it("warns instead of guessing when the block is valid YAML but not a mapping", () => {
    const scalar = parseFrontmatter("just some prose");
    assert.deepEqual(scalar.fields, {});
    assert.equal(scalar.warnings.length, 1);

    const sequence = parseFrontmatter("- a\n- b");
    assert.deepEqual(sequence.fields, {});
    assert.equal(sequence.warnings.length, 1);
  });

  it("coerces scalars to strings: number, boolean, explicit null, empty value", () => {
    const result = parseFrontmatter(
      [
        "importance: 3",
        "disabled: true",
        "ttl: false",
        "supersedes: null",
        "title:",
      ].join("\n")
    );
    assert.deepEqual(result.fields, {
      importance: "3",
      disabled: "true",
      ttl: "false",
      supersedes: "null",
      title: "",
    });
    assert.deepEqual(result.warnings, []);
  });

  it("renders the null spellings ~ and NULL as the string null", () => {
    assert.deepEqual(parseFrontmatter("a: ~\nb: NULL\nc: Null").fields, {
      a: "null",
      b: "null",
      c: "null",
    });
  });

  it("keeps a date-shaped scalar verbatim so memory round-trip bytes survive", () => {
    assert.deepEqual(
      parseFrontmatter("updated_at: 2026-01-01T00:00:00.000Z").fields,
      { updated_at: "2026-01-01T00:00:00.000Z" }
    );
  });

  it("never throws on malformed or adversarial blocks", () => {
    const inputs = [
      "\tfoo: bar",
      ": : :",
      "key: v\n bad: x",
      "name: unbalanced 'quote",
      "---\nnot a document",
      "%YAML 1.3\nfoo: bar",
    ];
    for (const block of inputs) {
      assert.doesNotThrow(
        () => parseFrontmatter(block),
        `block ${JSON.stringify(block)}`
      );
      const result = parseFrontmatter(block);
      assert.equal(typeof result.fields, "object");
      assert.ok(Array.isArray(result.warnings));
    }
  });

  it("reports no fields for a whitespace-only block", () => {
    const result = parseFrontmatter("   \n\t\n");
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.warnings, []);
  });
});
