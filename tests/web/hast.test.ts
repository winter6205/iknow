/**
 * hastText pure-helper tests.
 *
 * Mirrors tests/web/stop-reason.test.ts style: vitest describe/it +
 * node:assert/strict, root vitest (node env). The web package has no test
 * framework (project constraints forbid adding one).
 *
 * What we assert:
 *   - hastText recovers the original source text from the structural shape
 *     that react-markdown + rehype-highlight produce — including the hljs
 *     span tree that breaks the React children-projection path
 *     (empirically reproduces `const x = 1;` → ` :  = ;` when read via
 *     `React.Children.toArray(children).map(String)`).
 *   - text-only / nested element / element-without-children / null /
 *     undefined / comment nodes all behave consistently.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { hastText, type HastNodeLike } from "../../web/src/lib/hast.ts";

describe("hastText — text-only root", () => {
  it("extracts a single text node verbatim", () => {
    const node: HastNodeLike = {
      type: "root",
      children: [{ type: "text", value: "const x = 1;" }],
    };
    assert.equal(hastText(node), "const x = 1;");
  });

  it("concatenates sibling text nodes in order", () => {
    const node: HastNodeLike = {
      type: "root",
      children: [
        { type: "text", value: "const " },
        { type: "text", value: "x " },
        { type: "text", value: "= 1;" },
      ],
    };
    assert.equal(hastText(node), "const x = 1;");
  });
});

describe("hastText — nested element tree (hljs span shape)", () => {
  it("recurses through hljs-style span elements and recovers the source", () => {
    // Shape mirrors what rehype-highlight emits for `const x = 1;`:
    //   <span class="hljs-keyword">const</span>
    //   <span class="hljs-variable"> x </span>
    //   <span class="hljs-operator">=</span>
    //   <span class="hljs-number"> 1</span>
    //   <span class="hljs-punctuation">;</span>
    // All wrapped in an element <code> with root <pre>.
    const node: HastNodeLike = {
      type: "root",
      children: [
        {
          type: "element",
          children: [
            {
              type: "element",
              children: [{ type: "text", value: "const" }],
            },
            { type: "element", children: [{ type: "text", value: " x " }] },
            { type: "element", children: [{ type: "text", value: "=" }] },
            { type: "element", children: [{ type: "text", value: " 1" }] },
            { type: "element", children: [{ type: "text", value: ";" }] },
          ],
        },
      ],
    };
    assert.equal(hastText(node), "const x = 1;");
  });

  it("preserves whitespace and newlines across nested elements", () => {
    const node: HastNodeLike = {
      type: "element",
      children: [
        { type: "text", value: "line 1\n" },
        {
          type: "element",
          children: [
            { type: "text", value: "line " },
            { type: "element", children: [{ type: "text", value: "2" }] },
            { type: "text", value: "\nline 3" },
          ],
        },
      ],
    };
    assert.equal(hastText(node), "line 1\nline 2\nline 3");
  });

  it("skips comment nodes", () => {
    const node: HastNodeLike = {
      type: "root",
      children: [
        { type: "text", value: "before " },
        { type: "comment", value: " hidden annotation " },
        { type: "text", value: "after" },
      ],
    };
    assert.equal(hastText(node), "before after");
  });
});

describe("hastText — empty / missing inputs", () => {
  it("returns empty string for null", () => {
    assert.equal(hastText(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(hastText(undefined), "");
  });

  it("returns empty string for an element without children", () => {
    const node: HastNodeLike = { type: "element" };
    assert.equal(hastText(node), "");
  });

  it("returns empty string for a text node with no value", () => {
    const node: HastNodeLike = { type: "text" };
    assert.equal(hastText(node), "");
  });

  it("returns empty string for an empty children array", () => {
    const node: HastNodeLike = { type: "root", children: [] };
    assert.equal(hastText(node), "");
  });
});

describe("hastText — byte-equality acceptance for the H1 regression", () => {
  it("`const x = 1;` round-trips byte-for-byte", () => {
    // The exact shape of a single-element fenced code block parsed by
    // mdast-util-to-hast + rehype-highlight: root > element(pre) > element(code)
    // > [text, element(span hljs-keyword), text, element(span hljs-operator), ...].
    // We construct the simplified structural equivalent and assert byte equality.
    const node: HastNodeLike = {
      type: "root",
      children: [
        {
          type: "element",
          children: [
            {
              type: "element",
              children: [
                { type: "text", value: "const " },
                { type: "element", children: [{ type: "text", value: "x" }] },
                { type: "text", value: " " },
                { type: "element", children: [{ type: "text", value: "=" }] },
                { type: "text", value: " " },
                { type: "element", children: [{ type: "text", value: "1" }] },
                { type: "element", children: [{ type: "text", value: ";" }] },
              ],
            },
          ],
        },
      ],
    };
    // MarkdownBody strips the trailing "\n" that fenced blocks end with.
    const expected = "const x = 1;";
    assert.equal(hastText(node).replace(/\n$/, ""), expected);
    assert.equal(hastText(node).replace(/\n$/, "").length, expected.length);
  });
});
