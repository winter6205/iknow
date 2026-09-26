/**
 * stripFence — the frontmatter fence strip contract in docs/CONTEXT.md:
 * content-independent, never throws, byte-identical body slice. A
 * frontmatter block that is not valid YAML is still stripped, because
 * `skill()` body assembly, third-party skill-load envelope parsing and
 * KV-cache prefix stability all depend on the sliced bytes.
 *
 * `found` is asserted separately from `block === ""`: the skill scanner skips
 * the whole file when no fence matched, but keeps a file whose fence is empty.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { stripFence } from "../../../src/harness/frontmatter/index.ts";

describe("frontmatter stripFence", () => {
  it("reports no fence for plain text and returns the whole text as body", () => {
    const raw = "# Heading\nsome prose\n";
    assert.deepEqual(stripFence(raw), { found: false, block: "", body: raw });
  });

  it("distinguishes an empty fence from no fence at all", () => {
    const emptyFence = stripFence("---\n\n---\nbody\n");
    assert.equal(emptyFence.found, true);
    assert.equal(emptyFence.block, "");
    assert.equal(emptyFence.body, "body\n");

    const noFence = stripFence("---\n---\nbody\n");
    assert.equal(noFence.found, false);
    assert.equal(noFence.body, "---\n---\nbody\n");
  });

  it("treats an unterminated fence as no fence (whole text, never throws)", () => {
    const raw = "---\ntitle: never closed\nbody continues here\n";
    const result = stripFence(raw);
    assert.equal(result.found, false);
    assert.equal(result.block, "");
    assert.equal(result.body, raw);
  });

  it("recognises CRLF line endings in both fences", () => {
    const result = stripFence("---\r\ntitle: x\r\n---\r\nbody\r\n");
    assert.equal(result.found, true);
    assert.equal(result.block, "title: x");
    assert.equal(result.body, "body\r\n");
  });

  it("strips a fence whose block content is not valid YAML", () => {
    const raw = "---\n: : : not yaml [\n---\nbody\n";
    const result = stripFence(raw);
    assert.equal(result.found, true);
    assert.equal(result.block, ": : : not yaml [");
    assert.equal(result.body, "body\n");
  });

  it("returns the body as an exact byte-identical tail slice", () => {
    const raw = "---\r\ntitle: 数据 sets\r\n---\r\nbody 一行\r\ntail\r\n";
    const result = stripFence(raw);
    assert.equal(result.body, "body 一行\r\ntail\r\n");
    assert.ok(raw.endsWith(result.body));
  });

  it("does not rewrite any body byte (inner CRLF, tabs, blank lines kept)", () => {
    const body = "  indented\n\n\ttabbed\r\nünïcödé\r\n";
    const result = stripFence(`---\nname: x\n---\n${body}`);
    assert.equal(result.body, body);
  });

  it("requires the opening fence at offset 0 and accepts a closing fence at end of input", () => {
    assert.equal(stripFence("\n---\nname: x\n---\nbody\n").found, false);
    assert.equal(stripFence("----\nname: x\n---\nbody\n").found, false);
    const noTrailingNewline = stripFence("---\nname: x\n---");
    assert.equal(noTrailingNewline.found, true);
    assert.equal(noTrailingNewline.block, "name: x");
    assert.equal(noTrailingNewline.body, "");
  });

  it("returns an empty body and no fence for the empty string", () => {
    assert.deepEqual(stripFence(""), { found: false, block: "", body: "" });
  });

  it("never throws on adversarial input", () => {
    const inputs = ["---", "---\n", "---\n\n", "---\n---\n\n\n", "\r\n---\r\n"];
    for (const raw of inputs) {
      assert.doesNotThrow(
        () => stripFence(raw),
        `input ${JSON.stringify(raw)}`
      );
    }
  });
});
